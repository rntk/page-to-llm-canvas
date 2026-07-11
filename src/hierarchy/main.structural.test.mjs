/**
 * Structural tests for src/content/main.jsx.
 *
 * main.jsx is a browser content-script that cannot be imported in a Node.js
 * test environment (it references document, chrome.*, and React DOM). These
 * tests use ?raw source inspection to guard the critical structural properties
 * of the new pagetollm-scroll-to-topic-sentences message handler and the
 * updated openInPageRail options handling.
 */
import { describe, it, expect } from 'vitest';
import mainSource from '../content/main.jsx?raw';
import inPageRailControllerSource from '../content/inPageRailController.jsx?raw';

describe('pagetollm-scroll-to-topic-sentences message handler', () => {
  it('handles the pagetollm-scroll-to-topic-sentences message type', () => {
    expect(mainSource).toContain("'pagetollm-scroll-to-topic-sentences'");
  });

  it('calls removeCanvasIframe() when the message is received', () => {
    // The handler must close the canvas before opening the rail.
    const handlerBlock = mainSource.slice(
      mainSource.indexOf("'pagetollm-scroll-to-topic-sentences'"),
    );
    expect(handlerBlock).toContain('removeCanvasIframe()');
  });

  it('opens the in-page rail in topics mode', () => {
    const handlerBlock = mainSource.slice(
      mainSource.indexOf("'pagetollm-scroll-to-topic-sentences'"),
    );
    expect(handlerBlock).toContain("'topics'");
  });

  it('forwards sentenceNumbers from the message payload', () => {
    expect(mainSource).toContain('data.sentenceNumbers');
  });

  it('forwards level from the message payload', () => {
    expect(mainSource).toContain('data.level');
  });

  it('forwards topicPath from the message payload', () => {
    expect(mainSource).toContain('data.topicPath');
  });

  it('passes key derived from data.key when opening the rail', () => {
    expect(mainSource).toContain('data.key');
  });
});

describe('openInPageRail options handling', () => {
  it('accepts a third options parameter with a default of {}', () => {
    expect(inPageRailControllerSource).toContain('options = {}');
  });

  it('reads options.level to set selectedLevel', () => {
    expect(inPageRailControllerSource).toContain('options.level');
    expect(inPageRailControllerSource).toContain('selectedLevel');
  });

  it('defaults selectedLevel to 0 when options.level is not a number', () => {
    expect(inPageRailControllerSource).toContain("typeof options.level === 'number'");
  });

  it('calls highlightTopic with sentenceNumbers when provided', () => {
    expect(inPageRailControllerSource).toContain('highlightTopic(options.sentenceNumbers');
  });

  it('calls scrollToFirst with sentenceNumbers after highlighting', () => {
    expect(inPageRailControllerSource).toContain('scrollToFirst(options.sentenceNumbers)');
  });

  it('defers highlight and scroll into a requestAnimationFrame callback', () => {
    expect(inPageRailControllerSource).toContain('requestAnimationFrame');
    const rafBlock = inPageRailControllerSource.slice(
      inPageRailControllerSource.indexOf('requestAnimationFrame'),
    );
    expect(rafBlock).toContain('highlightTopic');
    expect(rafBlock).toContain('scrollToFirst');
  });
});
