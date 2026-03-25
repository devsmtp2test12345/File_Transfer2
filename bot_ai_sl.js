/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * * Architectural Blueprint: Autonomous Saved Search Generator Bot (Chat UI Edition)
 * Utilizes N/llm, Retrieval-Augmented Generation (RAG), SuiteScript JSON creation,
 * active search.save() validation, dynamic SuiteQL custom field extraction, usage quota limits, 
 * Out-Of-Domain (OOD) protection, dynamic search naming, and an asynchronous conversational frontend.
 * Includes Graceful Fallback for returning Draft JSON on validation failure.
 */

define(['N/ui/serverWidget', 'N/llm', 'N/search', 'N/query'], 
function (serverWidget, llm, search, query) {

    // --- Core Backend Utility Functions ---

    const calculateCosineSimilarity = (vecA, vecB) => {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += Math.pow(vecA[i], 2);
            normB += Math.pow(vecB[i], 2);
        }
        if (normA === 0 || normB === 0) return 0; 
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    const getFormattedDateString = () => {
        const d = new Date();
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        
        let hours = d.getHours();
        let ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12; 
        let minutes = d.getMinutes().toString().padStart(2, '0');
        
        return `(${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()} , ${hours.toString().padStart(2, '0')}:${minutes} ${ampm}, ${d.getFullYear()})`;
    };

    // --- RAG & AI Extraction Functions ---

    const retrieveRelevantSearches = (userQueryVector) => {
        const searchLibrary = []; 
        const libSearch = search.create({
            type: 'customrecord_ns_savedsearches_lib',
            columns: [
                'custrecord_savedsearches_description', 
                'custrecord_savedsearches_code', 
                'custrecord_savedsearches_embedding'
            ]
        });

        libSearch.run().each(result => {
            const embeddingString = result.getValue('custrecord_savedsearches_embedding');
            if (embeddingString) {
                const recordVector = JSON.parse(embeddingString);
                const similarity = calculateCosineSimilarity(userQueryVector, recordVector);
                searchLibrary.push({
                    id: result.id,
                    description: result.getValue('custrecord_savedsearches_description'),
                    code: result.getValue('custrecord_savedsearches_code'),
                    score: similarity
                });
            }
            return true;
        });
        return searchLibrary.sort((a, b) => b.score - a.score).slice(0, 3);
    };

    const extractFieldNames = (userQuery) => {
        const extractionPrompt = `Extract potential custom field names or labels from the following request. Return ONLY a valid JSON array of strings representing the field names. Do not include markdown, formatting, or explanations. Request: "${userQuery}"`;
        
        try {
            const llmResponse = llm.generateText({
                prompt: extractionPrompt,
                modelFamily: llm.ModelFamily.COHERE_COMMAND,
                modelParameters: { temperature: 0.1 }
            });
            
            let text = llmResponse.text.trim();
            if (text.startsWith('```')) {
                text = text.replace(/```(json)?/gi, '').replace(/```/g, '').trim();
            }
            return JSON.parse(text);
        } catch (e) {
            return []; 
        }
    };

    const lookupCustomFieldIds = (fieldNames) => {
        if (!fieldNames || fieldNames.length === 0) return {};
        const mapping = {};
        
        try {
            const placeholders = fieldNames.map(() => '?').join(', ');
            const sql = `SELECT scriptid, name FROM customfield WHERE name IN (${placeholders})`;
            
            const results = query.runSuiteQL({
                query: sql,
                params: fieldNames
            }).asMappedResults();

            results.forEach(res => {
                mapping[res.name] = res.scriptid;
            });
        } catch (e) {
            // Fail gracefully
        }
        return mapping;
    };

    // --- UI HTML/CSS/JS Payload ---

    const generateChatbotUI = (isQuotaExhausted, genQuota, embedQuota) => {
        const botGreeting = isQuotaExhausted 
            ? 'The AI Saved Search Bot is currently sleeping! 😴 We have exhausted our free NetSuite AI usage for the month. Please check back on the 1st.' 
            : 'Hello! I am ready to intelligently configure and build new Saved Searches for you directly in NetSuite. What data do you need to find today?';
        
        const disableInputAttr = isQuotaExhausted ? 'disabled' : '';
        const placeholderText = isQuotaExhausted ? 'Quota exhausted. Bot unavailable.' : 'e.g., Create a search for customers with open sales orders...';

        return `
        <style>
            #bot-workspace { position: relative; display: flex; justify-content: center; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
            
            /* Quota Badge Styles */
            .quota-badge { position: absolute; top: 20px; left: 20px; background-color: #ffffff; border: 1px solid #d3d8db; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); max-width: 380px; overflow: hidden; z-index: 10; }
            .quota-header-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; cursor: pointer; transition: background-color 0.2s; }
            .quota-header-row:hover { background-color: #f8f9fa; }
            .quota-header { color: #4d5f7a; font-size: 13px; font-weight: bold; margin-right: 15px; }
            .quota-toggle { font-size: 10px; color: #7f8c8d; user-select: none; transition: transform 0.3s ease; }
            .quota-details { display: none; padding: 12px 14px; background-color: #fafbfc; border-top: 1px solid #eaedf0; font-size: 12px; color: #5c6bc0; line-height: 1.5; }
            
            /* Chat Container Styles */
            #chat-container { width: 100%; max-width: 850px; border: 1px solid #d3d8db; border-radius: 12px; display: flex; flex-direction: column; height: 65vh; min-height: 500px; background-color: #f4f6f9; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            #chat-messages { flex-grow: 1; padding: 25px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
            .chat-message { max-width: 85%; padding: 14px 18px; border-radius: 8px; font-size: 14px; line-height: 1.5; word-wrap: break-word; }
            .user-msg { background-color: #607799; color: white; align-self: flex-end; border-bottom-right-radius: 2px; }
            .bot-msg { background-color: white; border: 1px solid #e1e5e8; color: #333; align-self: flex-start; border-bottom-left-radius: 2px; width: 100%; box-shadow: 0 2px 5px rgba(0,0,0,0.02); }
            .bot-msg pre { background-color: #2b303b; color: #c0c5ce; padding: 15px; border-radius: 6px; overflow-x: auto; font-family: 'Courier New', Courier, monospace; margin: 12px 0; font-size: 13px; }
            .action-btn { background-color: #e0e6ed; color: #333; border: 1px solid #cdd4dc; padding: 8px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; transition: all 0.2s; }
            .action-btn:hover { background-color: #d1d8e0; }
            .action-btn.view-btn { background-color: #2e7d32; color: white; border-color: #1b5e20; }
            .action-btn.view-btn:hover { background-color: #1b5e20; }
            .search-id-badge { display: inline-block; background-color: #e8f5e9; color: #2e7d32; padding: 6px 10px; border-radius: 4px; font-weight: bold; margin-bottom: 8px; border: 1px solid #c8e6c9; font-size: 13px;}
            #chat-input-area { display: flex; padding: 15px 20px; background-color: white; border-top: 1px solid #d3d8db; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; align-items: center; gap: 10px; }
            #chat-input { flex-grow: 1; padding: 12px 15px; border: 1px solid #cdd4dc; border-radius: 6px; font-size: 14px; outline: none; transition: border-color 0.2s; }
            #chat-input:focus { border-color: #607799; }
            #chat-input:disabled { background-color: #f0f2f5; cursor: not-allowed; }
            #send-btn { background-color: #4d5f7a; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: bold; transition: background-color 0.2s; }
            #send-btn:hover { background-color: #3b495e; }
            #send-btn:disabled { background-color: #a0abbc; cursor: not-allowed; }
            .typing-indicator { font-style: italic; color: #7f8c8d; font-size: 13px; }
            .button-row { display: flex; gap: 10px; margin-top: 10px; }
            .error-notice { color: #d32f2f; }
        </style>

        <div id="bot-workspace">
            <div class="quota-badge">
                <div class="quota-header-row" onclick="toggleQuotaDetails()">
                    <div class="quota-header">⚡ Remaining AI Usage : ${genQuota} Gen | ${embedQuota} emb</div>
                    <div class="quota-toggle" id="quota-toggle-icon">▼</div>
                </div>
                <div class="quota-details" id="quota-details-content">
                    <strong style="color: #333;">Gen (Search Generation):</strong> The AI has the capacity to write and deploy approximately <strong>${genQuota}</strong> more searches for you this month.<br><br>
                    <strong style="color: #333;">Embed (Deep Searching):</strong> The AI can perform <strong>${embedQuota}</strong> more intelligent background searches into the NetSuite knowledge base to understand your specific requests this month.
                </div>
            </div>
            
            <div id="chat-container">
                <div id="chat-messages">
                    <div class="chat-message bot-msg">
                        <strong>NetSuite AI Saved Search Bot</strong><br>
                        ${botGreeting}
                    </div>
                </div>
                <div id="chat-input-area">
                    <input type="text" id="chat-input" placeholder="${placeholderText}" onkeypress="if(event.key === 'Enter') sendQuery()" ${disableInputAttr} />
                    <button type="button" id="send-btn" onclick="sendQuery()" ${disableInputAttr}>Build Search</button>
                </div>
            </div>
        </div>

        <script>
            function toggleQuotaDetails() {
                const details = document.getElementById('quota-details-content');
                const icon = document.getElementById('quota-toggle-icon');
                if (details.style.display === 'block') {
                    details.style.display = 'none';
                    icon.innerHTML = '▼';
                } else {
                    details.style.display = 'block';
                    icon.innerHTML = '▲';
                }
            }

            async function sendQuery() {
                const inputField = document.getElementById('chat-input');
                const sendBtn = document.getElementById('send-btn');
                const query = inputField.value.trim();

                if (!query) return;

                appendMessage(query, 'user-msg');
                inputField.value = '';
                inputField.disabled = true;
                sendBtn.disabled = true;

                const loadingId = 'loading-' + Date.now();
                appendMessage('Thinking, configuring search, and validating against NetSuite database schema...', 'bot-msg typing-indicator', loadingId);

                try {
                    const response = await fetch(window.location.href, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query: query })
                    });

                    const data = await response.json();
                    document.getElementById(loadingId).remove(); 

                    if (data.success) {
                        const codeId = 'code-' + Date.now();
                        const htmlResponse = \`
                            <strong>✅ Saved Search Created Successfully!</strong><br><br>
                            <div class="search-id-badge">Name: \${escapeHtml(data.searchName)}</div><br>
                            <div class="search-id-badge">Internal ID: \${escapeHtml(data.savedSearchId)}</div><br>
                            <em>Review the generated configuration below:</em>
                            <pre id="\${codeId}">\${escapeHtml(data.searchCode)}</pre>
                            
                            <div class="button-row">
                                <button type="button" class="action-btn" onclick="copyToClipboard('\${codeId}', this)">
                                    📋 Copy JSON Config
                                </button>
                                <button type="button" class="action-btn view-btn" onclick="window.open('/app/common/search/searchresults.nl?searchid=\${data.savedSearchId}', '_blank')">
                                    👁️ View Search
                                </button>
                            </div>
                        \`;
                        appendHtmlMessage(htmlResponse, 'bot-msg');
                    } else {
                        // Handle standard errors vs OOD notices
                        let errorPrefix = '<span class="error-notice">❌ Creation Failed:</span> ';
                        if (data.error.includes("specialized NetSuite AI")) {
                            errorPrefix = '🤖 Notice: ';
                        }
                        
                        let errorHtml = \`<strong>\${errorPrefix}</strong><br>\${escapeHtml(data.error)}\`;
                        
                        // If we have a draft fallback, render it with a copy button
                        if (data.draftCode) {
                            const draftId = 'draft-' + Date.now();
                            errorHtml += \`<br><br><em>Draft Configuration (Requires Manual Fix):</em>
                                <pre id="\${draftId}">\${escapeHtml(data.draftCode)}</pre>
                                <div class="button-row">
                                    <button type="button" class="action-btn" onclick="copyToClipboard('\${draftId}', this)">
                                        📋 Copy Draft JSON
                                    </button>
                                </div>\`;
                        }
                        
                        appendHtmlMessage(errorHtml, 'bot-msg');
                    }
                } catch (error) {
                    document.getElementById(loadingId).remove();
                    appendMessage('⚠️ System Error: ' + error.message, 'bot-msg');
                } finally {
                    inputField.disabled = false;
                    sendBtn.disabled = false;
                    inputField.focus();
                    scrollToBottom();
                }
            }

            function appendMessage(text, className, id = '') {
                const messagesArea = document.getElementById('chat-messages');
                const msgDiv = document.createElement('div');
                msgDiv.className = 'chat-message ' + className;
                if (id) msgDiv.id = id;
                msgDiv.textContent = text;
                messagesArea.appendChild(msgDiv);
                scrollToBottom();
            }

            function appendHtmlMessage(html, className) {
                const messagesArea = document.getElementById('chat-messages');
                const msgDiv = document.createElement('div');
                msgDiv.className = 'chat-message ' + className;
                msgDiv.innerHTML = html;
                messagesArea.appendChild(msgDiv);
                scrollToBottom();
            }

            function scrollToBottom() {
                const messagesArea = document.getElementById('chat-messages');
                messagesArea.scrollTop = messagesArea.scrollHeight;
            }

            function copyToClipboard(elementId, btnElement) {
                const textToCopy = document.getElementById(elementId).textContent;
                navigator.clipboard.writeText(textToCopy).then(() => {
                    const originalText = btnElement.innerHTML;
                    btnElement.innerHTML = '✅ Copied!';
                    setTimeout(() => { btnElement.innerHTML = originalText; }, 2000);
                }).catch(err => {
                    console.error('Failed to copy: ', err);
                });
            }

            function escapeHtml(unsafe) {
                if (unsafe === null || unsafe === undefined) return '';
                return String(unsafe)
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;")
                    .replace(/'/g, "&#039;");
            }
        </script>
        `;
    };

    /**
     * Primary Suitelet Request Handler
     */
    const onRequest = (context) => {
        let isQuotaExhausted = false;
        let genQuota = 'N/A';
        let embedQuota = 'N/A';
        
        try {
            genQuota = llm.getRemainingFreeUsage();
            embedQuota = llm.getRemainingFreeEmbedUsage();
            if (genQuota <= 0 || embedQuota <= 0) {
                isQuotaExhausted = true;
            }
        } catch (e) {
            isQuotaExhausted = false;
        }

        if (context.request.method === 'GET') {
            const form = serverWidget.createForm({ title: 'AI Saved Search Assistant', hideNavBar: false });
            const htmlField = form.addField({ id: 'custpage_chat_ui', type: serverWidget.FieldType.INLINEHTML, label: 'Chat UI' });
            htmlField.defaultValue = generateChatbotUI(isQuotaExhausted, genQuota, embedQuota);
            context.response.writePage(form);
            
        } else if (context.request.method === 'POST') {
            let responsePayload = { success: false, searchCode: '', savedSearchId: '', searchName: '', error: '', draftCode: '' };

            if (isQuotaExhausted) {
                responsePayload.error = "The AI Bot is currently sleeping! 😴 We have exhausted our free NetSuite AI usage for the month.";
                context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
                context.response.write(JSON.stringify(responsePayload));
                return; 
            }

            try {
                const requestBody = JSON.parse(context.request.body);
                const userQuery = requestBody.query;

                let finalSearchCode = '';
                let createdSavedSearchId = '';
                let createdSearchName = '';
                let lastDraftedJson = ''; // Variable to hold the graceful fallback code
                let validationAttempts = 0;
                const maxAttempts = 3;

                // Step 1: Vectorize user query
                const queryEmbeddingResponse = llm.embed({
                    inputs: [userQuery],
                    embedModelFamily: llm.EmbedModelFamily.COHERE_EMBED
                });
                const userQueryVector = queryEmbeddingResponse.embeddings[0]; 

                // Step 2: RAG Retrieval for Saved Searches
                const contextRecords = retrieveRelevantSearches(userQueryVector);
                const ragDocuments = contextRecords.map((rec, index) => {
                    return llm.createDocument({
                        id: `doc_${index}`,
                        data: `Description: ${rec.description}\nCode/Syntax: ${rec.code}`
                    });
                });

                // Step 2.5: Agentic Field Extraction
                let customFieldMappingText = "";
                try {
                    const potentialFields = extractFieldNames(userQuery);
                    if (potentialFields && potentialFields.length > 0) {
                        const fieldMapping = lookupCustomFieldIds(potentialFields);
                        if (Object.keys(fieldMapping).length > 0) {
                            customFieldMappingText = ` IMPORTANT: Use these accurate NetSuite Script IDs for the requested custom fields in your filters or columns: ${JSON.stringify(fieldMapping)}.`;
                        }
                    }
                } catch (extractionErr) {}

                // Step 3: Generation & Active Save Validation
                let currentPrompt = `You are a strict NetSuite SuiteScript 2.x expert bot. Analyze the request: "${userQuery}". If this is conversational or completely unrelated to NetSuite saved searches, reply with exactly: "OOD_REQUEST". Otherwise, generate the JSON configuration required for 'search.create(options)'. The JSON MUST strictly contain 'type' (a string internal id like 'salesorder', 'customer', etc.), 'filters' (a valid array of filter expressions/objects), 'columns' (an array of strings or column objects), and a 'title' (a concise, descriptive name based on the user's request, e.g., 'Top 10 Sellers This Week'). DO NOT include an 'id' in the JSON.${customFieldMappingText} Return ONLY the raw, valid JSON object (or "OOD_REQUEST"). No markdown, no conversational text.`;

                while (validationAttempts < maxAttempts) {
                    const llmResponse = llm.generateText({
                        prompt: currentPrompt,
                        documents: ragDocuments, 
                        modelFamily: llm.ModelFamily.COHERE_COMMAND, 
                        modelParameters: { temperature: 0.1, maxTokens: 1500 }
                    });

                    let generatedText = llmResponse.text.trim();
                    
                    if (generatedText.includes('OOD_REQUEST')) {
                        responsePayload.error = "I am a specialized NetSuite AI bot. I can only answer questions and generate logic related to creating NetSuite saved searches. Please ask me a search-related question!";
                        break; 
                    }
                    
                    try {
                        if (generatedText.startsWith('```')) {
                            generatedText = generatedText.replace(/^```(json)?/gi, '').replace(/```$/gi, '').trim();
                        }
                        
                        const parsedSearchConfig = JSON.parse(generatedText);
                        
                        const timestamp = new Date().getTime();
                        parsedSearchConfig.id = `customsearch_ai_bot_${timestamp}`;
                        
                        const llmGeneratedTitle = parsedSearchConfig.title || 'AI Generated Search';
                        parsedSearchConfig.title = `${llmGeneratedTitle} ${getFormattedDateString()}`;

                        // Capture the formatted JSON *before* NetSuite attempts to validate/save it
                        lastDraftedJson = JSON.stringify(parsedSearchConfig, null, 4);

                        const newSearch = search.create(parsedSearchConfig);
                        createdSavedSearchId = newSearch.save(); 
                        createdSearchName = parsedSearchConfig.title;
                        
                        finalSearchCode = lastDraftedJson;
                        break; 

                    } catch (e) {
                        validationAttempts++;
                        currentPrompt = `You generated this JSON: ${generatedText}. It resulted in this NetSuite compilation/save error: ${e.message}. Fix the JSON structure and valid search column/filter syntax. Return ONLY the corrected raw JSON.`;
                    }
                }

                // Prepare API Response
                if (createdSavedSearchId) {
                    responsePayload.success = true;
                    responsePayload.savedSearchId = String(createdSavedSearchId); 
                    responsePayload.searchName = createdSearchName;
                    responsePayload.searchCode = finalSearchCode;
                } else if (!responsePayload.error) {
                    // Fallback triggered: provide the user with the last drafted code
                    responsePayload.error = "I couldn't successfully save this to NetSuite (likely due to a missing or invalid custom field ID). However, I've generated a draft configuration for you below. You can copy this, update the field names, and use it in your code!";
                    responsePayload.draftCode = lastDraftedJson;
                }

            } catch (err) {
                responsePayload.error = "System Error: " + err.message;
            }

            context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
            context.response.write(JSON.stringify(responsePayload));
        }
    };

    return { onRequest };
});
