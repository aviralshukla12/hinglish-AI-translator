// Handle context menu for highlighted text translation
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "translateToHinglish",
    title: "Translate to Hinglish",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: "explainInHinglish",
    title: "Explain in Hinglish",
    contexts: ["selection"]
  });
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translateText") {
    translateText(request.text)
      .then(sendResponse)
      .catch(error => {
        console.error("Translation error:", error);
        sendResponse("Translation error: " + error.message);
      });
    return true; // Required for async sendResponse
  }
  if (request.action === "explainText") {
    explainText(request.text)
      .then(sendResponse)
      .catch(error => {
        console.error("Explanation error:", error);
        sendResponse("Explanation error: " + error.message);
      });
    return true; // Required for async sendResponse
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "translateToHinglish") {
    try {
      // 1. Show loading popup
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showLoadingPopup
      });

      // 2. Enhanced selection extraction (handles <li> elements gracefully)
      const [{ result: selectedText }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) return '';

          const range = selection.getRangeAt(0);
          const fragment = range.cloneContents();
          const container = document.createElement('div');
          container.appendChild(fragment);

          // Gather text with bullets if it's a list
          const items = container.querySelectorAll('li');
          if (items.length > 0) {
            return Array.from(items).map(li => '• ' + li.innerText.trim()).join('\n');
          }

          // Fallback to plain text with preserved line breaks
          return container.innerText || selection.toString();
        }
      });

      if (!selectedText || selectedText.trim() === '') {
        throw new Error("No text selected");
      }

      // 3. Format newline characters
      const formattedText = selectedText.replace(/\n/g, '\n\n');

      // 4. Translate the structured list text
      const translatedText = await translateText(formattedText);

      // 5. Show the translation popup
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showTranslationPopup,
        args: [selectedText, translatedText]
      });

    } catch (error) {
      console.error("Translation error:", error);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showErrorPopup,
        args: [error.message || "Something went wrong"]
      });
    }
  }
});

const promptCache={};

// Function to get translation prompt based on style and level
function getTranslationPrompt(style, level) {
   

   const structureInstruction = `
  Keep the original structure, including:
- Bullet points
- Line breaks
- Paragraphs
- Indentation (if any)

Do not remove or reorder items.
Only respond with the translated text — no comments or explanations.
`;
  const prompts = {
    hinglish: {
      balanced: "You are a translator that converts English text to Hinglish (Hindi written in English letters). Keep the meaning exactly the same but make it sound natural in Hinglish. Use a balanced mix of Hindi and English words. Only respond with the translated text, no explanations.",
      moreHindi: "You are a translator that converts English text to Hinglish (Hindi written in English letters). Keep the meaning exactly the same but make it sound natural in Hinglish. Use more Hindi words than English. Only respond with the translated text, no explanations.",
      moreEnglish: "You are a translator that converts English text to Hinglish (Hindi written in English letters). Keep the meaning exactly the same but make it sound natural in Hinglish. Use more English words than Hindi. Only respond with the translated text, no explanations."
    },
    hindi: {
      balanced: "You are a translator that converts English text to Hindi (Devanagari script). Keep the meaning exactly the same but make it sound natural in Hindi. Use a balanced mix of formal and colloquial Hindi. Only respond with the translated text, no explanations.",
      moreHindi: "You are a translator that converts English text to Hindi (Devanagari script). Keep the meaning exactly the same but make it sound natural in Hindi. Use more formal Hindi words. Only respond with the translated text, no explanations.",
      moreEnglish: "You are a translator that converts English text to Hindi (Devanagari script). Keep the meaning exactly the same but make it sound natural in Hindi. Use more colloquial Hindi words. Only respond with the translated text, no explanations."
    },
    roman: {
      balanced: "You are a translator that converts Hindi text to Romanized Hindi (Hindi written in English letters). Keep the meaning exactly the same but make it sound natural. Use a balanced mix of formal and colloquial words. Only respond with the translated text, no explanations.",
      moreHindi: "You are a translator that converts Hindi text to Romanized Hindi (Hindi written in English letters). Keep the meaning exactly the same but make it sound natural. Use more formal words. Only respond with the translated text, no explanations.",
      moreEnglish: "You are a translator that converts Hindi text to Romanized Hindi (Hindi written in English letters). Keep the meaning exactly the same but make it sound natural. Use more colloquial words. Only respond with the translated text, no explanations."
    },
    formal: {
      balanced: "You are a translator that converts English text to formal Hinglish (Hindi written in English letters). Keep the meaning exactly the same but make it sound professional and formal. Use a balanced mix of Hindi and English words. Only respond with the translated text, no explanations.",
      moreHindi: "You are a translator that converts English text to formal Hinglish (Hindi written in English letters). Keep the meaning exactly the same but make it sound professional and formal. Use more Hindi words than English. Only respond with the translated text, no explanations.",
      moreEnglish: "You are a translator that converts English text to formal Hinglish (Hindi written in English letters). Keep the meaning exactly the same but make it sound professional and formal. Use more English words than Hindi. Only respond with the translated text, no explanations."
    },
    casual: {
      balanced: "You are a translator that converts English text to casual Hinglish (Hindi written in English letters). Keep the meaning exactly the same but make it sound casual and conversational. Use a balanced mix of Hindi and English words. Only respond with the translated text, no explanations.",
      moreHindi: "You are a translator that converts English text to casual Hinglish (Hindi written in English letters). Keep the meaning exactly the same but make it sound casual and conversational. Use more Hindi words than English. Only respond with the translated text, no explanations.",
      moreEnglish: "You are a translator that converts English text to casual Hinglish (Hindi written in English letters). Keep the meaning exactly the same but make it sound casual and conversational. Use more English words than Hindi. Only respond with the translated text, no explanations."
    }
  };

   return       basePrompt=prompts[style]?.[level] || prompts.hinglish.balanced;
 
}

// Function to translate text using Groq API
async function translateText(text) {
  const { groqApiKey, translationSettings } = await chrome.storage.local.get(['groqApiKey', 'translationSettings']);
  
  if (!groqApiKey) {
    throw new Error("Please configure your API key first");
  }

  const style = translationSettings?.style || 'hinglish';
  const level = translationSettings?.level || 'balanced';
  const baseprompt = getTranslationPrompt(style, level);

    const prompt = `
${basePrompt}

If multiple sentences are provided separated by "--SPLIT--", translate each one individually in the same order. Separate translations using "---SPLIT---".
  `.trim()

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        messages: [{
          role: "system",
          content: prompt
        }, {
          role: "user",
          content: text
        }],
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        temperature: 0.7,
        max_tokens: 1000
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API error: ${response.status}`);
    }
    
    const data = await response.json();
    const translatedText = data.choices[0].message.content.trim();
    
    if (!translatedText) {
      throw new Error("Empty translation received");
    }
    
    return translatedText;
  } catch (error) {
    console.error("Translation error:", error);
    throw error;
  }
}

// Function to explain text using Groq API
async function explainText(text) {
  const { groqApiKey, translationSettings } = await chrome.storage.local.get(['groqApiKey', 'translationSettings']);
  
  if (!groqApiKey) {
    throw new Error("Please configure your API key first");
  }

  const style = translationSettings?.style || 'hinglish';
  const level = translationSettings?.level || 'balanced';
  const prompt = `You are an AI assistant that explains concepts in ${style === 'hindi' ? 'Hindi' : 'Hinglish'}. 
    Provide a clear and detailed explanation of the given text. 
    Make it easy to understand and use ${level === 'moreHindi' ? 'more Hindi words' : level === 'moreEnglish' ? 'more English words' : 'a balanced mix of Hindi and English words'}.
    Format your response in a clear, structured way with bullet points or short paragraphs.
    Only respond with the explanation, no additional text.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        messages: [{
          role: "system",
          content: prompt
        }, {
          role: "user",
          content: text
        }],
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        temperature: 0.7,
        max_tokens: 1000
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API error: ${response.status}`);
    }
    
    const data = await response.json();
    const explanation = data.choices[0].message.content.trim();
    
    if (!explanation) {
      throw new Error("Empty explanation received");
    }
    
    return explanation;
  } catch (error) {
    console.error("Explanation error:", error);
    throw error;
  }
}

// Function to show loading popup
function showLoadingPopup() {
  const popup = document.createElement('div');
  popup.id = 'translationLoadingPopup';
  popup.style.position = 'fixed';
  popup.style.zIndex = '9999';
  popup.style.borderRadius = '8px';
  popup.style.padding = '20px';
  popup.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  popup.style.maxWidth = '300px';
  popup.style.fontFamily = 'Arial, sans-serif';
  popup.style.fontSize = '14px';
  popup.style.top = '50%';
  popup.style.left = '50%';
  popup.style.transform = 'translate(-50%, -50%)';
  popup.style.textAlign = 'center';
  
  // Dark mode detection and styling
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    popup.style.backgroundColor = '#2d2d2d';
    popup.style.color = '#ffffff';
    popup.style.border = '1px solid #444';
  } else {
    popup.style.backgroundColor = '#ffffff';
    popup.style.color = '#333333';
    popup.style.border = '1px solid #ddd';
  }
  
  popup.innerHTML = `
    <div style="margin-bottom: 15px; font-size: 15px;">Processing...</div>
    <div class="loading-spinner" style="
      width: 30px;
      height: 30px;
      border: 3px solid rgba(0,0,0,0.1);
      border-top: 3px solid #1a73e8;
      border-radius: 50%;
      margin: 0 auto;
      animation: spin 1s linear infinite;
    "></div>
  `;
  
  // Add the animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
  
  document.body.appendChild(popup);
}

// Function to show translation popup
function showTranslationPopup(originalText, translatedText) {
  // Remove loading popup if it exists
  const loadingPopup = document.getElementById('translationLoadingPopup');
  if (loadingPopup) {
    document.body.removeChild(loadingPopup);
  }

  // Remove existing popup if any
  const oldPopup = document.querySelector('.hinglish-popup');
  if (oldPopup) {
    document.body.removeChild(oldPopup);
  }

  // Create popup container
  const popup = document.createElement('div');
  popup.className = 'hinglish-popup';
  popup.style.position = 'fixed';
  popup.style.zIndex = '9999';
  popup.style.borderRadius = '8px';
  popup.style.padding = '20px';
  popup.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  popup.style.maxWidth = '400px';
  popup.style.fontFamily = 'Arial, sans-serif';
  popup.style.fontSize = '14px';
  popup.style.top = '50%';
  popup.style.left = '50%';
  popup.style.transform = 'translate(-50%, -50%)';

  const isDarkMode = window.matchMedia &&
                     window.matchMedia('(prefers-color-scheme: dark)').matches;

  popup.style.backgroundColor = isDarkMode ? '#2d2d2d' : '#ffffff';
  popup.style.color = isDarkMode ? '#ffffff' : '#333333';
  popup.style.border = isDarkMode ? '1px solid #444' : '1px solid #ddd';

  // === Content container
  const content = document.createElement('div');

  const originalLabel = document.createElement('div');
  originalLabel.style.fontWeight = 'bold';
  originalLabel.style.marginBottom = '8px';
  originalLabel.style.color = isDarkMode ? '#aaa' : '#666';
  originalLabel.textContent = 'Original Text:';

  const originalBox = document.createElement('div');
  originalBox.style.background = isDarkMode ? '#3a3a3a' : '#f5f5f5';
  originalBox.style.padding = '12px';
  originalBox.style.borderRadius = '6px';
  originalBox.style.marginBottom = '15px';
  originalBox.style.lineHeight = '1.5';
  originalBox.style.whiteSpace = 'pre-wrap';
  originalBox.textContent = originalText;

  const translatedLabel = document.createElement('div');
  translatedLabel.style.fontWeight = 'bold';
  translatedLabel.style.marginBottom = '8px';
  translatedLabel.style.color = isDarkMode ? '#aaa' : '#666';
  translatedLabel.textContent = 'Translation:';

  const translatedBox = document.createElement('div');
  translatedBox.style.background = isDarkMode ? '#1a3d6d' : '#e8f0fe';
  translatedBox.style.padding = '12px';
  translatedBox.style.borderRadius = '6px';
  translatedBox.style.marginBottom = '15px';
  translatedBox.style.lineHeight = '1.5';
  translatedBox.style.whiteSpace = 'pre-wrap';
  translatedBox.textContent = translatedText;

  // Append to content
  content.appendChild(originalLabel);
  content.appendChild(originalBox);
  content.appendChild(translatedLabel);
  content.appendChild(translatedBox);

  // === Close button
  const buttonWrapper = document.createElement('div');
  buttonWrapper.style.textAlign = 'right';

  const closeButton = document.createElement('button');
  closeButton.textContent = 'Close';
  closeButton.style.cursor = 'pointer';
  closeButton.style.padding = '8px 16px';
  closeButton.style.background = '#1a73e8';
  closeButton.style.color = 'white';
  closeButton.style.border = 'none';
  closeButton.style.borderRadius = '4px';
  closeButton.style.fontSize = '14px';
  closeButton.style.transition = 'background 0.2s';

  closeButton.addEventListener('mouseenter', () => {
    closeButton.style.background = '#0d5bc1';
  });
  closeButton.addEventListener('mouseleave', () => {
    closeButton.style.background = '#1a73e8';
  });
  closeButton.addEventListener('click', () => {
    document.body.removeChild(popup);
  });

  buttonWrapper.appendChild(closeButton);

  // Final assembly
  popup.appendChild(content);
  popup.appendChild(buttonWrapper);
  document.body.appendChild(popup);

  // Optional: click outside to close
  document.addEventListener('click', function outsideClick(e) {
    if (!popup.contains(e.target)) {
      document.body.removeChild(popup);
      document.removeEventListener('click', outsideClick);
    }
  });
}

function showTranslationPopup(originalText, translatedText) {
  // Remove loading popup if it exists
  const loadingPopup = document.getElementById('translationLoadingPopup');
  if (loadingPopup) {
    document.body.removeChild(loadingPopup);
  }

  const popup = document.createElement('div');
  popup.className = 'hinglish-popup';
  popup.style.position = 'fixed';
  popup.style.zIndex = '9999';
  popup.style.borderRadius = '8px';
  popup.style.padding = '20px';
  popup.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  popup.style.maxWidth = '400px';
  popup.style.fontFamily = 'Arial, sans-serif';
  popup.style.fontSize = '14px';
  popup.style.top = '50%';
  popup.style.left = '50%';
  popup.style.transform = 'translate(-50%, -50%)';
  
  // Dark mode detection and styling
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    popup.style.backgroundColor = '#2d2d2d';
    popup.style.color = '#ffffff';
    popup.style.border = '1px solid #444';
    
    popup.innerHTML = `
      <div style="margin-bottom: 15px;">
        <div style="font-weight: bold; margin-bottom: 8px; color: #aaa;">Original Text:</div>
        <div style="background: #3a3a3a; padding: 12px; border-radius: 6px; margin-bottom: 15px; line-height: 1.5;">${originalText}</div>
        <div style="font-weight: bold; margin-bottom: 8px; color: #aaa;">Translation:</div>
        <div style="background: #1a3d6d; padding: 12px; border-radius: 6px; margin-bottom: 15px; line-height: 1.5;">${translatedText}</div>
      </div>
      <div style="text-align: right;">
        <button id="closePopup" style="
          cursor: pointer;
          padding: 8px 16px;
          background: #1a73e8;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          transition: background 0.2s;
        ">Close</button>
      </div>
    `;
  } else {
    popup.style.backgroundColor = '#ffffff';
    popup.style.color = '#333333';
    popup.style.border = '1px solid #ddd';
    
    popup.innerHTML = `
      <div style="margin-bottom: 15px;">
        <div style="font-weight: bold; margin-bottom: 8px; color: #666;">Original Text:</div>
        <div style="background: #f5f5f5; padding: 12px; border-radius: 6px; margin-bottom: 15px; line-height: 1.5;">${originalText}</div>
        <div style="font-weight: bold; margin-bottom: 8px; color: #666;">Translation:</div>
        <div style="background: #e8f0fe; padding: 12px; border-radius: 6px; margin-bottom: 15px; line-height: 1.5;">${translatedText}</div>
      </div>
      <div style="text-align: right;">
        <button id="closePopup" style="
          cursor: pointer;
          padding: 8px 16px;
          background: #1a73e8;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          transition: background 0.2s;
        ">Close</button>
      </div>
    `;
  }
  
  document.body.appendChild(popup);
  
  // Close button functionality
  const closeButton = popup.querySelector('#closePopup');
  closeButton.addEventListener('click', () => {
    document.body.removeChild(popup);
  });
  
  // Hover effect for close button
  closeButton.addEventListener('mouseenter', () => {
    closeButton.style.background = '#0d5bc1';
  });
  closeButton.addEventListener('mouseleave', () => {
    closeButton.style.background = '#1a73e8';
  });
  
  // Close when clicking outside
  document.addEventListener('click', function outsideClick(e) {
    if (!popup.contains(e.target)) {
      document.body.removeChild(popup);
      document.removeEventListener('click', outsideClick);
    }
  });
}

// Function to show explanation popup
function showExplanationPopup(originalText, explanation) {
  // Remove loading popup if it exists
  const loadingPopup = document.getElementById('translationLoadingPopup');
  if (loadingPopup) {
    document.body.removeChild(loadingPopup);
  }

  const popup = document.createElement('div');
  popup.className = 'hinglish-popup';
  popup.style.position = 'fixed';
  popup.style.zIndex = '9999';
  popup.style.borderRadius = '8px';
  popup.style.padding = '20px';
  popup.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  popup.style.maxWidth = '500px';
  popup.style.fontFamily = 'Arial, sans-serif';
  popup.style.fontSize = '14px';
  popup.style.top = '50%';
  popup.style.left = '50%';
  popup.style.transform = 'translate(-50%, -50%)';
  
  // Dark mode detection and styling
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    popup.style.backgroundColor = '#2d2d2d';
    popup.style.color = '#ffffff';
    popup.style.border = '1px solid #444';
    
    popup.innerHTML = `
      <div style="margin-bottom: 15px;">
        <div style="font-weight: bold; margin-bottom: 8px; color: #aaa;">Original Text:</div>
        <div style="background: #3a3a3a; padding: 12px; border-radius: 6px; margin-bottom: 15px; line-height: 1.5;">${originalText}</div>
        <div style="font-weight: bold; margin-bottom: 8px; color: #aaa;">AI Explanation:</div>
        <div style="background: #1a3d6d; padding: 12px; border-radius: 6px; margin-bottom: 15px; line-height: 1.5; white-space: pre-wrap; max-height: 300px; overflow-y: auto;">${explanation}</div>
      </div>
      <div style="text-align: right;">
        <button id="closePopup" style="
          cursor: pointer;
          padding: 8px 16px;
          background: #1a73e8;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          transition: background 0.2s;
        ">Close</button>
      </div>
    `;
  } else {
    popup.style.backgroundColor = '#ffffff';
    popup.style.color = '#333333';
    popup.style.border = '1px solid #ddd';
    
    popup.innerHTML = `
      <div style="margin-bottom: 15px;">
        <div style="font-weight: bold; margin-bottom: 8px; color: #666;">Original Text:</div>
        <div style="background: #f5f5f5; padding: 12px; border-radius: 6px; margin-bottom: 15px; line-height: 1.5;">${originalText}</div>
        <div style="font-weight: bold; margin-bottom: 8px; color: #666;">AI Explanation:</div>
        <div style="background: #e8f0fe; padding: 12px; border-radius: 6px; margin-bottom: 15px; line-height: 1.5; white-space: pre-wrap; max-height: 300px; overflow-y: auto;">${explanation}</div>
      </div>
      <div style="text-align: right;">
        <button id="closePopup" style="
          cursor: pointer;
          padding: 8px 16px;
          background: #1a73e8;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          transition: background 0.2s;
        ">Close</button>
      </div>
    `;
  }
  
  document.body.appendChild(popup);
  
  // Close button functionality
  const closeButton = popup.querySelector('#closePopup');
  closeButton.addEventListener('click', () => {
    document.body.removeChild(popup);
  });
  
  // Hover effect for close button
  closeButton.addEventListener('mouseenter', () => {
    closeButton.style.background = '#0d5bc1';
  });
  closeButton.addEventListener('mouseleave', () => {
    closeButton.style.background = '#1a73e8';
  });
  
  // Close when clicking outside
  document.addEventListener('click', function outsideClick(e) {
    if (!popup.contains(e.target)) {
      document.body.removeChild(popup);
      document.removeEventListener('click', outsideClick);
    }
  });
}

// Function to show error popup
function showErrorPopup(errorMessage) {
  // Remove loading popup if it exists
  const loadingPopup = document.getElementById('translationLoadingPopup');
  if (loadingPopup) {
    document.body.removeChild(loadingPopup);
  }

  const popup = document.createElement('div');
  popup.className = 'hinglish-popup';
  popup.style.position = 'fixed';
  popup.style.zIndex = '9999';
  popup.style.borderRadius = '8px';
  popup.style.padding = '20px';
  popup.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  popup.style.maxWidth = '300px';
  popup.style.fontFamily = 'Arial, sans-serif';
  popup.style.fontSize = '14px';
  popup.style.top = '50%';
  popup.style.left = '50%';
  popup.style.transform = 'translate(-50%, -50%)';
  
  // Dark mode detection and styling
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    popup.style.backgroundColor = '#2d2d2d';
    popup.style.color = '#ffffff';
    popup.style.border = '1px solid #444';
    
    popup.innerHTML = `
      <div style="margin-bottom: 15px;">
        <div style="font-weight: bold; margin-bottom: 8px; color: #ff6b6b;">Error:</div>
        <div style="margin-bottom: 15px; line-height: 1.5;">${errorMessage}</div>
      </div>
      <div style="text-align: right;">
        <button id="closePopup" style="
          cursor: pointer;
          padding: 8px 16px;
          background: #d93025;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          transition: background 0.2s;
        ">Close</button>
      </div>
    `;
  } else {
    popup.style.backgroundColor = '#ffffff';
    popup.style.color = '#333333';
    popup.style.border = '1px solid #ddd';
    
    popup.innerHTML = `
      <div style="margin-bottom: 15px;">
        <div style="font-weight: bold; margin-bottom: 8px; color: #d93025;">Error:</div>
        <div style="margin-bottom: 15px; line-height: 1.5;">${errorMessage}</div>
      </div>
      <div style="text-align: right;">
        <button id="closePopup" style="
          cursor: pointer;
          padding: 8px 16px;
          background: #d93025;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          transition: background 0.2s;
        ">Close</button>
      </div>
    `;
  }
  
  document.body.appendChild(popup);
  
  // Close button functionality
  const closeButton = popup.querySelector('#closePopup');
  closeButton.addEventListener('click', () => {
    document.body.removeChild(popup);
  });
  
  // Hover effect for close button
  closeButton.addEventListener('mouseenter', () => {
    closeButton.style.background = '#c5221f';
  });
  closeButton.addEventListener('mouseleave', () => {
    closeButton.style.background = '#d93025';
  });
  
  // Auto close after 5 seconds
  setTimeout(() => {
    if (document.body.contains(popup)) {
      document.body.removeChild(popup);
    }
  }, 5000);
}