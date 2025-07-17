// Listen for messages from popup or background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "translatePage") {
      translatePageContent();
    }
  });
  
  // Function to translate the entire page
  async function translatePageContent() {
    // Show loading indicator
    const loadingIndicator = document.createElement('div');
    loadingIndicator.style.position = 'fixed';
    loadingIndicator.style.top = '10px';
    loadingIndicator.style.right = '10px';
    loadingIndicator.style.padding = '10px';
    loadingIndicator.style.backgroundColor = '#1a73e8';
    loadingIndicator.style.color = 'white';
    loadingIndicator.style.borderRadius = '4px';
    loadingIndicator.style.zIndex = '9999';
    loadingIndicator.textContent = 'Translating page...';
    document.body.appendChild(loadingIndicator);

    try {
      // Get user preference for translation mode
      const { translationMode } = await chrome.storage.local.get(['translationMode']);
      const mode = translationMode || 'paragraphs';
      
      if (mode === 'paragraphs') {
        await translateParagraphs();
      } else {
        await translateAllText();
      }

      loadingIndicator.textContent = 'Translation complete!';
      loadingIndicator.style.backgroundColor = '#0b8043';
      setTimeout(() => loadingIndicator.remove(), 2000);
    } catch (error) {
      console.error('Translation error:', error);
      loadingIndicator.textContent = 'Translation failed!';
      loadingIndicator.style.backgroundColor = '#d93025';
      setTimeout(() => loadingIndicator.remove(), 2000);
    }
  }
  
  // Translate paragraph by paragraph
  async function translateParagraphs() {
    const paragraphs = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, span, div');
    let translatedCount = 0;
    
    for (let i = 0; i < paragraphs.length; i++) {
      const element = paragraphs[i];
      if (element.textContent.trim() && 
          element.childNodes.length === 1 && 
          element.childNodes[0].nodeType === Node.TEXT_NODE &&
          !element.classList.contains('hinglish-translated')) {
        
        const originalText = element.textContent;
        
        try {
          const response = await chrome.runtime.sendMessage({
            action: "translateText",
            text: originalText
          });
          
          if (response && response !== "Please configure your API key first") {
            element.textContent = response;
            element.classList.add('hinglish-translated');
            translatedCount++;
          }
        } catch (error) {
          console.error('Translation error:', error);
        }
      }
    }
    
    return translatedCount;
  }

  //translate all text
  // Translate all text nodes (more aggressive approach)
async function translateAllText(batchSize = 3) {
    console.time('translateAllText');
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let node;
  const textNodes = [];

  // Collect text nodes that should be translated
  while (node = walker.nextNode()) {
    if (
      node.textContent.trim() &&
      node.parentElement &&
      !node.parentElement.classList.contains('hinglish-translated')
    ) {
      textNodes.push(node);
    }
  }

  let translatedCount = 0;

  // Process in batches
  for (let i = 0; i < textNodes.length; i += batchSize) {
    const batch = textNodes.slice(i, i + batchSize);
    const originalText = batch.map(n => n.textContent.trim());
    const combineText = originalText.join("\n--SPLIT--\n");

    try {
      const response = await chrome.runtime.sendMessage({
        action: "translateText",
        text: combineText
      });

      if (response && response !== "Please configure your API key first") {
        const translatedParts = response.split("\n---SPLIT---\n");

        batch.forEach((node, index) => {
          const translated = translatedParts[index]?.trim();
          if (translated) {
            node.textContent = translated;
            node.parentElement?.classList.add("hinglish-translated");
            translatedCount++;
          }
        });
      }
    } catch (error) {
      console.error("Batch translation error:", error);
    }
  }
  console.timeEnd("translateAllText");
  return translatedCount;
}

  