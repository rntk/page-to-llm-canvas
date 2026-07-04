/**
 * Interactive Script for Extension Canvas Documentation Page
 */

// 1. Screencast Video Player Controller
const screencastsData = {
  'how-pick-block': {
    title: 'Picking a Page Block',
    src: 'media/screencasts/how-pick-block.webm',
    desc: 'Start pick mode from the extension popup, choose the content block on the page, and click "Submit" to send that area into the pipeline.',
  },
  'page-summaries': {
    title: 'Generating Page Summaries',
    src: 'media/screencasts/page-summaries.webm',
    desc: 'Select portions of an article, run processing, and view the summaries generated for each block, with status indicators for splitting and summarizing along the way.',
  },
  'canvas-topics': {
    title: 'Canvas Topics Exploration',
    src: 'media/screencasts/canvas-topics.webm',
    desc: 'Open the canvas view to see topics laid out as cards. Pan and zoom, and select a card to read its full summary.',
  },
  'page-topics-hierarchy': {
    title: 'Topics Hierarchy Sidebar',
    src: 'media/screencasts/page-topics-hierarchy.webm',
    desc: 'The hierarchy sidebar lists topics and subtopics in nested levels. Clicking a node in the sidebar highlights and centers the matching block on the canvas.',
  },
  'page-topics': {
    title: 'Page Topics & Inline Tags',
    src: 'media/screencasts/page-topics.webm',
    desc: 'Topics are shown inline on the source page as tags attached to block headers, so you can see what each section is about before reading it.',
  },
};

const videoPlayer = document.getElementById('screencast-video');
const videoSource = document.getElementById('screencast-source');
const videoOverlay = document.getElementById('video-overlay');
const videoWrapper = videoPlayer ? videoPlayer.closest('.video-wrapper') : null;
const screencastTitle = document.getElementById('screencast-title');
const screencastDesc = document.getElementById('screencast-description');

function selectScreencast(id, element) {
  const data = screencastsData[id];
  if (!data || !videoPlayer || !videoSource) return;

  // Active Button Class Highlight
  document.querySelectorAll('.screencast-tab-btn').forEach((btn) => {
    btn.classList.remove('active');
  });
  element.classList.add('active');

  // Change Video Source & Details
  videoSource.src = data.src;
  screencastTitle.textContent = data.title;
  screencastDesc.textContent = data.desc;

  // Reload Video
  videoPlayer.load();

  // Play Video
  videoPlayer
    .play()
    .then(() => {
      if (videoWrapper) videoWrapper.classList.add('playing');
    })
    .catch((err) => {
      console.log('Video autoplay prevented: ', err);
      if (videoWrapper) videoWrapper.classList.remove('playing');
    });
}

function togglePlayVideo() {
  if (!videoPlayer) return;

  if (videoPlayer.paused) {
    videoPlayer.play();
  } else {
    videoPlayer.pause();
  }
}

if (videoPlayer) {
  videoPlayer.addEventListener('play', () => {
    if (videoWrapper) videoWrapper.classList.add('playing');
  });

  videoPlayer.addEventListener('pause', () => {
    if (videoWrapper) videoWrapper.classList.remove('playing');
  });

  videoPlayer.addEventListener('ended', () => {
    if (videoWrapper) videoWrapper.classList.remove('playing');
  });
}

// 2. Onboarding Code Tab Switcher
function switchCodeTab(event, tabId) {
  const tabContainer = event.target.closest('.code-tab-container');
  if (!tabContainer) return;

  // Deactivate all buttons & contents inside this container
  tabContainer.querySelectorAll('.code-tab-btn').forEach((btn) => btn.classList.remove('active'));
  tabContainer
    .querySelectorAll('.code-tab-content')
    .forEach((content) => content.classList.remove('active'));

  // Activate selected button & content
  event.target.classList.add('active');
  const selectedContent = tabContainer.querySelector(`#${tabId}`);
  if (selectedContent) selectedContent.classList.add('active');
}

// 4. Lightbox Modal for Screenshots
const lightbox = document.getElementById('gallery-lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxCaption = document.getElementById('lightbox-caption');

// Attach click listeners to all screenshots & gallery images
document.addEventListener('DOMContentLoaded', () => {
  const triggers = document.querySelectorAll('.lightbox-trigger');
  triggers.forEach((img) => {
    img.addEventListener('click', () => {
      if (!lightbox || !lightboxImg || !lightboxCaption) return;

      lightbox.style.display = 'flex';
      lightboxImg.src = img.src;
      lightboxCaption.textContent = img.alt || 'Extension Canvas Preview';
    });
  });
});

function closeLightbox() {
  if (lightbox) {
    lightbox.style.display = 'none';
  }
}

// Close Lightbox on Click Outside of Image
if (lightbox) {
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) {
      closeLightbox();
    }
  });
}

// Close Lightbox on ESC Key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeLightbox();
  }
});

// 5. FAQ Accordion Toggle
function toggleFaq(button) {
  const item = button.closest('.faq-item');
  if (!item) return;

  const answer = item.querySelector('.faq-answer');
  const isActive = item.classList.contains('active');

  // Close other open FAQs for cleaner UI
  document.querySelectorAll('.faq-item').forEach((faq) => {
    faq.classList.remove('active');
    const ans = faq.querySelector('.faq-answer');
    if (ans) ans.style.maxHeight = null;
  });

  // Toggle clicked FAQ
  if (!isActive && answer) {
    item.classList.add('active');
    answer.style.maxHeight = answer.scrollHeight + 'px';
  }
}

// Programmatic bindings & window exports for ESLint compliance
if (videoOverlay) {
  videoOverlay.addEventListener('click', togglePlayVideo);
}

window.selectScreencast = selectScreencast;
window.togglePlayVideo = togglePlayVideo;
window.switchCodeTab = switchCodeTab;
window.closeLightbox = closeLightbox;
window.toggleFaq = toggleFaq;
