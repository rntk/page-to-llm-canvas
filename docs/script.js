/**
 * Interactive Script for PageToLLM Canvas Documentation Page
 */

// 1. Onboarding Code Tab Switcher
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

// 2. Per-use-case Media Switchers
function setupMediaSwitchers() {
  document.querySelectorAll('[data-media-switcher]').forEach((switcher) => {
    const tabs = Array.from(switcher.querySelectorAll('[role="tab"]'));
    const panels = Array.from(switcher.querySelectorAll('[role="tabpanel"]'));

    const activateTab = (activeTab) => {
      const activePanelId = activeTab.getAttribute('aria-controls');

      tabs.forEach((tab) => {
        const isActive = tab === activeTab;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        tab.tabIndex = isActive ? 0 : -1;
      });

      panels.forEach((panel) => {
        const isActive = panel.id === activePanelId;
        panel.hidden = !isActive;
        if (!isActive) panel.querySelector('video')?.pause();
      });
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activateTab(tab));
      tab.addEventListener('keydown', (event) => {
        let nextIndex = null;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex === null) return;

        event.preventDefault();
        activateTab(tabs[nextIndex]);
        tabs[nextIndex].focus();
      });
    });
  });
}

document.addEventListener('DOMContentLoaded', setupMediaSwitchers);

// 3. Lightbox Modal for Screenshots
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
      lightboxCaption.textContent = img.alt || 'PageToLLM Canvas Preview';
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

// 4. FAQ Accordion Toggle
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
window.switchCodeTab = switchCodeTab;
window.closeLightbox = closeLightbox;
window.toggleFaq = toggleFaq;
