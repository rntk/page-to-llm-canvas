// Pipeline entry point: clean HTML, split sentences, find topic ranges, and
// generate per-topic summaries. This runs in the service-worker context.

import { formatPipelineError } from './pipelineRuntime.js';
import { computeTopics } from './topicRangesStage.js';
import { finalizeSummariesDisabled, runSummaries } from './summaryStage.js';
import { isCancellationError } from './cancellation.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';
import { getPipelineTextChunkMaxChars, getTopicRangeInputMaxSentences } from './pipelineConfig.js';

// A resumable checkpoint must carry the sentence texts its topics reference.
// If `sentences` is missing/short, out-of-range sentence ids get silently
// dropped and a blank summary can be finalized as "done". Refuse the
// checkpoint in place rather than recomputing topics, which would erase any
// valid summaries that survived a partial write.
//
// Two failure classes are handled differently. A structurally malformed
// topic — no usable nonblank string `name`, `sentences` not an array, or an
// out-of-range sentence id — refuses the WHOLE checkpoint even if other
// topics are healthy. A well-formed topic that simply cannot yield a summary
// is tolerated per topic: that covers both an empty `sentences` array and
// sentences resolving to blank source text, which reach summaryStage the same
// way and finalize as an empty entry. The checkpoint is refused only when NO
// topic can yield a summary.
export function isSummaryCheckpointComplete(record) {
  if (!Array.isArray(record?.topics) || record.topics.length === 0) return false;
  if (!Array.isArray(record.sentences) || record.sentences.length === 0) return false;
  const sentenceCount = record.sentences.length;
  const hasSourceText = (oneIdx) => {
    const text = record.sentences[oneIdx - 1];
    return typeof text === 'string' && text.trim() !== '';
  };

  let summarizableTopics = 0;
  for (const topic of record.topics) {
    if (typeof topic?.name !== 'string' || topic.name.trim() === '') return false;
    if (!Array.isArray(topic.sentences)) return false;
    if (
      !topic.sentences.every(
        (oneIdx) => Number.isInteger(oneIdx) && oneIdx >= 1 && oneIdx <= sentenceCount,
      )
    ) {
      return false;
    }
    if (topic.sentences.some(hasSourceText)) summarizableTopics++;
  }
  return summarizableTopics > 0;
}

/**
 * A summary checkpoint is tied to the content revision whose sentences and
 * topics it references.  Missing revisions are deliberately not treated as
 * compatible: imported/legacy records cannot prove that their checkpoint was
 * derived from the current content, so they take the fresh topic-building
 * path instead of reusing potentially stale summaries.
 *
 * @param {object} record
 * @returns {boolean}
 */
export function isSummaryCheckpointRevisionCurrent(record) {
  const contentRevision = record?.contentRevision;
  const checkpointRevision = record?.summaryCheckpointContentRevision;
  return (
    typeof contentRevision === 'string' &&
    contentRevision !== '' &&
    typeof checkpointRevision === 'string' &&
    checkpointRevision !== '' &&
    checkpointRevision === contentRevision
  );
}

/**
 * Purely classifies the record snapshot before the orchestrator performs any
 * resume-side effects. A current-but-malformed checkpoint is preserved for an
 * explicit Reprocess decision; a stale checkpoint is rebuilt from source.
 *
 * @param {object} record
 * @returns {{resuming: boolean, rejectionReason: string|null}}
 */
export function planResume(record) {
  const isSummarizing = record?.status === PIPELINE_STATUS.SUMMARIZING;
  const hasCheckpointTopics =
    isSummarizing && Array.isArray(record?.topics) && record.topics.length > 0;
  const revisionCurrent = isSummaryCheckpointRevisionCurrent(record);
  const checkpointComplete = hasCheckpointTopics && isSummaryCheckpointComplete(record);
  // A current checkpoint revision means this record already reached the
  // summary boundary. Preserve it on every structural failure, including a
  // missing/empty topic list, rather than falling into computeTopics and
  // destructively clearing any summary work that survived the malformed write.
  if (isSummarizing && revisionCurrent && !checkpointComplete) {
    return {
      resuming: false,
      rejectionReason: 'incomplete_checkpoint',
    };
  }
  return {
    resuming: revisionCurrent && checkpointComplete,
    rejectionReason: hasCheckpointTopics && !revisionCurrent ? 'content_revision_mismatch' : null,
  };
}

/**
 * Creates one explicitly owned pipeline runner.
 *
 * Construction resolves the limiter once and installs the concurrency-setting
 * listener that mutates it. Call the runner once per realm, not once per run.
 * `dispose` reverses only that subscription; it deliberately neither resets nor
 * destroys an externally shared limiter, whose lifetime belongs to the
 * composition root and may include article-chat consumers.
 *
 * `limiterFactory` keeps limiter construction at the composition root. The
 * returned limiter may also gate other provider-facing surfaces (article chat)
 * so one setting controls the provider's aggregate concurrency.
 *
 * @param {object} deps
 * @param {Function} deps.runtimeFactory
 * @param {{getPreferContentLanguage: Function, getVerboseLogs: Function,
 *   getMaxParallelLlmRequests: Function, normalizeMaxParallelLlmRequests: Function,
 *   subscribeToMaxParallelLlmRequests: Function}} deps.settings
 * @param {{getActiveProvider: Function}} deps.providerRepository
 * @param {{callLLMWithRetry: Function}} deps.llm
 * @param {function(): {run: Function, setLimit: Function}} deps.limiterFactory
 *   Called exactly once per runner. A realm-level composition root may return
 *   its existing shared limiter; otherwise the factory may create one seeded
 *   with the same default the settings module normalizes towards.
 * @param {{wrapCallLLMWithRetry: Function}} deps.telemetry
 * @param {{info: Function, error: Function}} deps.logger
 * @returns {{runPipeline: Function, dispose: Function}}
 */
export function createPipelineRunner({
  runtimeFactory,
  settings,
  providerRepository,
  llm,
  limiterFactory,
  telemetry,
  logger,
}) {
  const limiter = limiterFactory();
  const measuredCallLLMWithRetry = telemetry.wrapCallLLMWithRetry(llm.callLLMWithRetry);
  // The limiter slot is held for the whole retry loop, including backoff sleeps,
  // not just the HTTP call, so a replacement request can't hit the same
  // failing/rate-limited provider mid-backoff. The signal is passed through so a
  // queued call can still be cancelled without waiting for a slot.
  const callLLMWithRetry = (opts, maxRetries) =>
    limiter.run(() => measuredCallLLMWithRetry(opts, maxRetries), opts?.signal);
  let concurrencySettingRevision = 0;
  let disposed = false;
  const unsubscribe = settings.subscribeToMaxParallelLlmRequests((newValue) => {
    if (disposed) return;
    concurrencySettingRevision++;
    limiter.setLimit(settings.normalizeMaxParallelLlmRequests(newValue));
  });

  /**
   * Runs or resumes the persisted article-processing pipeline.
   *
   * @param {string} key
   * @param {object} [options]
   * @param {string} [options.pipelineRunId]
   * @param {AbortSignal} [options.signal]
   */
  async function runPipeline(key, options = {}) {
    const runtimeContext = {
      key,
      pipelineRunId: options.pipelineRunId,
      signal: options.signal,
      summariesDisabled: false,
    };
    // Keep a minimal runtime available so settings/provider bootstrap failures
    // still follow the normal pipeline error and logging path.
    let runtime = runtimeFactory(runtimeContext);

    const concurrencyRevisionAtRead = concurrencySettingRevision;
    try {
      const [preferContentLanguage, verboseLogs, maxParallelLlmRequests, activeProvider] =
        await Promise.all([
          settings.getPreferContentLanguage(),
          settings.getVerboseLogs(),
          settings.getMaxParallelLlmRequests(),
          // The provider snapshot sizes and handles every request in this run.
          // A missing provider remains an ordinary request-boundary error, but an
          // inability to read provider storage must retain its real cause.
          providerRepository.getActiveProvider(),
        ]);
      if (concurrencySettingRevision === concurrencyRevisionAtRead) {
        limiter.setLimit(maxParallelLlmRequests);
      }
      // Size and dispatch against the same snapshot. A provider selected later is
      // picked up by the next pipeline run instead of silently changing this run's
      // context limit between requests or retries.
      const callRunLLMWithRetry = (opts, maxRetries) =>
        callLLMWithRetry({ ...opts, provider: activeProvider }, maxRetries);

      runtime = runtimeFactory({
        ...runtimeContext,
        preferContentLanguage,
        verboseLogs,
        maxTextChunkChars: getPipelineTextChunkMaxChars(activeProvider?.contextWindowTokens),
        maxTopicRangeSentences: getTopicRangeInputMaxSentences(activeProvider?.contextWindowTokens),
      });
      await runtime.log('pipeline_start');
      const record = await runtime.read();
      if (!record) throw new Error(`record not found: ${key}`);
      runtime.setSummariesDisabled(record.skipSummaries === true);

      // `topic_summaries` is the leaf checkpoint used to resume/retry summary
      // work after service-worker recycling; UI consumers read
      // `topic_summary_index` instead.
      const resumePlan = planResume(record);
      // A matching revision plus malformed structure is unsafe to consume and
      // must preserve the checkpoint for an explicit Reprocess decision.  A
      // stale or legacy revision is different: the saved topics are not proven
      // to belong to this content, so rebuild them through computeTopics rather
      // than displaying or summarizing stale data.
      const resuming = resumePlan.resuming;
      if (resumePlan.rejectionReason) {
        await runtime.log('pipeline_resume_rejected', {
          stage: PIPELINE_STAGE.SUMMARIZING,
          reason: resumePlan.rejectionReason,
          topicCount: Array.isArray(record.topics) ? record.topics.length : 0,
          sentenceCount: Array.isArray(record.sentences) ? record.sentences.length : 0,
        });
      }
      if (resumePlan.rejectionReason === 'incomplete_checkpoint') {
        throw new Error(
          'Cannot resume summaries because the saved sentence checkpoint is incomplete. Reprocess the record to rebuild it.',
        );
      }

      let topics;
      let sentenceTexts;
      if (resuming) {
        topics = record.topics;
        sentenceTexts = Array.isArray(record.sentences) ? record.sentences : [];
        // A resume completes one logical summary run. Keep its language policy
        // stable even if the global preference changed while the worker was
        // stopped, so reused and newly generated summaries cannot mix languages.
        if (typeof record.summaryCheckpointPreferContentLanguage === 'boolean') {
          runtime.preferContentLanguage = record.summaryCheckpointPreferContentLanguage;
        }
        const existingSummaries =
          record.topic_summaries && typeof record.topic_summaries === 'object'
            ? record.topic_summaries
            : {};
        await runtime.log('pipeline_resume', {
          stage: PIPELINE_STAGE.SUMMARIZING,
          topicCount: topics.length,
          existingSummaryCount: Object.keys(existingSummaries).length,
        });
        await runtime.update({
          status: PIPELINE_STATUS.SUMMARIZING,
          error: null,
          summaryErrors: [],
          summariesIncomplete: false,
        });
      } else {
        ({ topics, sentenceTexts } = await computeTopics({
          runtime,
          record,
          callLLMWithRetry: callRunLLMWithRetry,
        }));
        if (!topics) return;
      }

      if (runtime.summariesDisabled) {
        await finalizeSummariesDisabled(runtime, topics, {
          preserveExistingSummaries: resuming,
        });
        return;
      }

      const previousSummaries =
        resuming && record.topic_summaries && typeof record.topic_summaries === 'object'
          ? record.topic_summaries
          : {};
      const previousSummaryIndex =
        resuming && record.topic_summary_index && typeof record.topic_summary_index === 'object'
          ? record.topic_summary_index
          : {};
      const forceFinalize = resuming && record.forceFinalize === true;
      const acceptedMergeFailurePaths =
        forceFinalize && Array.isArray(record.acceptedMergeFailurePaths)
          ? record.acceptedMergeFailurePaths
          : [];
      await runSummaries({
        runtime,
        topics,
        sentenceTexts,
        previousSummaries,
        previousSummaryIndex,
        previousSourceSummaryUnits:
          resuming && record.source_summary_units && typeof record.source_summary_units === 'object'
            ? record.source_summary_units
            : {},
        contentRevision:
          typeof record.contentRevision === 'string' && record.contentRevision
            ? record.contentRevision
            : null,
        forceFinalize,
        acceptedMergeFailurePaths,
        callLLMWithRetry: callRunLLMWithRetry,
      });
    } catch (error) {
      if (isCancellationError(error, runtime)) {
        // A superseded run id or external cancel lands here; leave the record's
        // status alone (a newer run owns it) but log so it's not invisible.
        logger.info('aborted:', key, (error && error.message) || error);
        return;
      }

      const formattedError = formatPipelineError(error);
      // A provider failure can settle just after the signal aborts; let the
      // run-id CAS decide ownership instead of treating it as cancellation.
      await runtime.log('pipeline_error', { error: formattedError }, { allowAborted: true });
      await runtime
        .update({ status: PIPELINE_STATUS.ERROR, error: formattedError }, { allowAborted: true })
        .catch((writeError) => {
          logger.error('failed to persist error status to storage:', writeError);
        });
      throw error;
    } finally {
      await runtime.flushLogs();
    }
  }

  return {
    runPipeline,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
    },
  };
}
