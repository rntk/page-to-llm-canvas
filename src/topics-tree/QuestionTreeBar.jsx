import { QUESTION_TREE_STAGE } from '../shared/runtime/questionTree.js';
import SummaryTreeBar from './SummaryTreeBar.jsx';

const STAGE_LABELS = {
  [QUESTION_TREE_STAGE.QUESTIONS]: 'Finding questions',
  [QUESTION_TREE_STAGE.GROUPING]: 'Grouping questions',
};

function describeDone(tree) {
  const { questions = 0, groups = 0 } = tree?.metrics || {};
  const count = `${questions} ${questions === 1 ? 'question' : 'questions'}`;
  return groups ? `${count} · ${groups} ${groups === 1 ? 'group' : 'groups'}` : count;
}

export default function QuestionTreeBar(props) {
  return (
    <SummaryTreeBar
      {...props}
      stageLabels={STAGE_LABELS}
      describeDone={describeDone}
      introText="Find the questions each part of the article answers, along with supporting points and source sentences."
      buildLabel="Find questions"
      rebuildTitle="Find questions again from scratch"
      resumeTitle="Continue from the completed parts"
    />
  );
}
