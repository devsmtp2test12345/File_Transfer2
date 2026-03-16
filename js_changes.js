/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * * Architectural Blueprint: High-Accuracy Formula Generator Bot (Chat UI Edition)
 * Utilizes N/llm, Retrieval-Augmented Generation (RAG), programmatic search validation,
 * and an asynchronous conversational frontend.
 */

define(['N/ui/serverWidget', 'N/llm', 'N/search', 'N/query'], 
function (serverWidget, llm, search, query) {

    // --- Core Backend Functions (Untouched for stability) ---

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

    const retrieveRelevantFormulas = (userQueryVector) => {
        const formulaLibrary = []; 
        const formulaSearch = search.create({
            type: 'customrecord_ns_formula_lib',
            columns: [
                'custrecord_formula_description', 
                'custrecord_formula_syntax', 
                'custrecord_formula_embedding'
            ]
        });

        formulaSearch.run().each(result => {
            const embeddingString = result.getValue('custrecord_formula_embedding');
            if (embeddingString) {
                const recordVector = JSON.parse(embeddingString);
                const similarity = calculateCosineSimilarity(userQueryVector, recordVector);
                formulaLibrary.push({
                    id: result.id,
                    description: result.getValue('custrecord_formula_description'),
                    syntax: result.getValue('custrecord_formula_syntax'),
                    score: similarity
                });
            }
            return true;
        });
        return formulaLibrary.sort((a, b) => b.score - a.score).slice(0, 3);
    };

    const validateFormulaSyntax = (formulaString) => {
        try {
            search.create({
                type: search.Type.CUSTOMER,
                columns: [search.createColumn({ name: 'formulatext', formula: formulaString })] 
            });
            return { isValid: true, error: null };
        } catch (e) {
            return { isValid: false, error: e.message };
        }
    };

    // --- UI HTML/CSS/JS Payload ---

    const generateChatbotUI = () => {
        return `
        <style>
            #bot-workspace { display: flex; justify-content: center; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
            #chat-container { width: 100%; max-width: 850px; border: 1px solid #d3d8db; border-radius: 12px; display: flex; flex-direction: column; height: 65vh; min-height: 500px; background-color: #f4f6f9; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            #chat-messages { flex-grow: 1; padding: 25px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
            .chat-message { max-width: 85%; padding: 14px 18px; border-radius: 8px; font-size: 14px; line-height: 1.5; word-wrap: break-word; }
            .user-msg { background-color: #607799; color: white; align-self: flex-end; border-bottom-right-radius: 2px; }
            .bot-msg { background-color: white; border: 1px solid #e1e5e8; color: #333; align-self: flex-start; border-bottom-left-radius: 2px; width: 100%; box-shadow: 0 2px 5px rgba(0,0,0,0.02); }
            .bot-msg pre { background-color: #2b303b; color: #c0c5ce; padding: 15px; border-radius: 6px; overflow-x: auto; font-family: 'Courier New', Courier, monospace; margin: 12px 0; font-size: 13px; }
            .copy-btn { background-color: #e0e6ed; color: #333; border: 1px solid #cdd4dc; padding: 8px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; transition: all 0.2s; }
            .copy-btn:hover { background-color: #d1d8e0; }
            #chat-input-area { display: flex; padding: 15px 20px; background-color: white; border-top: 1px solid #d3d8db; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; align-items: center; gap: 10px; }
            #chat-input { flex-grow: 1; padding: 12px 15px; border: 1px solid #cdd4dc; border-radius: 6px; font-size: 14px; outline: none; transition: border-color 0.2s; }
            #chat-input:focus { border-color: #607799; }
            #send-btn { background-color: #4d5f7a; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: bold; transition: background-color 0.2s; }
            #send-btn:hover { background-color: #3b495e; }
            #send-btn:disabled { background-color: #a0abbc; cursor: not-allowed; }
            .typing-indicator { font-style: italic; color: #7f8c8d; font-size: 13px; }
        </style>

        <div id="bot-workspace">
            <div id="chat-container">
                <div id="chat-messages">
                    <div class="chat-message bot-msg">
                        <strong>NetSuite AI Formula Bot</strong><br>
                        Hello! I am ready to generate and validate complex saved search formulas for you. What logic do you need help writing today?
                    </div>
                </div>
                <div id="chat-input-area">
                    <input type="text" id="chat-input" placeholder="e.g., Calculate days between date created and closed..." onkeypress="if(event.key === 'Enter') sendQuery()" />
                    <button id="send-btn" onclick="sendQuery()">Generate</button>
                </div>
            </div>
        </div>

        <script>
            async function sendQuery() {
                const inputField = document.getElementById('chat-input');
                const sendBtn = document.getElementById('send-btn');
                const query = inputField.value.trim();

                if (!query) return;

                // 1. Render User Message
                appendMessage(query, 'user-msg');
                inputField.value = '';
                inputField.disabled = true;
                sendBtn.disabled = true;

                // 2. Render Loading State
                const loadingId = 'loading-' + Date.now();
                appendMessage('Thinking, generating, and compiling formula against NetSuite search engine...', 'bot-msg typing-indicator', loadingId);

                try {
                    // 3. Send Async POST Request to this Suitelet
                    const response = await fetch(window.location.href, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query: query })
                    });

                    const data = await response.json();
                    document.getElementById(loadingId).remove(); // Clear loading

                    // 4. Render Bot Response
                    if (data.success) {
                        const formulaId = 'code-' + Date.now();
                        const htmlResponse = \`
                            <strong>Validated Formula Generated:</strong>
                            <pre id="\${formulaId}">\${escapeHtml(data.formula)}</pre>
                            <button class="copy-btn" onclick="copyToClipboard('\${formulaId}', this)">
                                📋 Copy Formula
                            </button>
                        \`;
                        appendHtmlMessage(htmlResponse, 'bot-msg');
                    } else {
                        appendMessage('❌ Validation Failed: ' + data.error, 'bot-msg');
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

            // --- Helper Functions ---
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
                return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
            }
        </script>
        `;
    };

    /**
     * Primary Suitelet Request Handler executing the architectural flow.
     */
    const onRequest = (context) => {
        if (context.request.method === 'GET') {
            // Render the Chat UI wrapper
            const form = serverWidget.createForm({ title: 'AI Formula Assistant', hideNavBar: false });
            
            const htmlField = form.addField({
                id: 'custpage_chat_ui',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Chat UI'
            });
            
            htmlField.defaultValue = generateChatbotUI();
            context.response.writePage(form);
            
        } else if (context.request.method === 'POST') {
            // Act as an API endpoint for the frontend Javascript
            let responsePayload = { success: false, formula: '', error: '' };

            try {
                // Parse the JSON payload sent via fetch()
                const requestBody = JSON.parse(context.request.body);
                const userQuery = requestBody.query;

                let finalFormula = '';
                let validationAttempts = 0;
                const maxAttempts = 3;

                // Architectural Step 1: Vectorize the user's natural language query
                const queryEmbeddingResponse = llm.embed({
                    inputs: [userQuery],
                    embedModelFamily: llm.EmbedModelFamily.COHERE_EMBED
                });
                const userQueryVector = queryEmbeddingResponse.embeddings[0]; 

                // Architectural Step 2: RAG Retrieval
                const contextRecords = retrieveRelevantFormulas(userQueryVector);
                const ragDocuments = contextRecords.map((rec, index) => {
                    return llm.createDocument({
                        id: `doc_${index}`,
                        data: `Description: ${rec.description}\nSyntax: ${rec.syntax}`
                    });
                });

                // Architectural Step 3: Generation and Strict Validation Loop
                let currentPrompt = `You are a NetSuite PL/SQL expert. Write a NetSuite saved search formula for the following request: ${userQuery}. Return ONLY the raw formula text without markdown formatting or conversational filler.`;

                while (validationAttempts < maxAttempts) {
                    const llmResponse = llm.generateText({
                        prompt: currentPrompt,
                        documents: ragDocuments, 
                        modelFamily: llm.ModelFamily.COHERE_COMMAND, 
                        modelParameters: { temperature: 0.1, maxTokens: 1000 }
                    });

                    const generatedText = llmResponse.text.trim();
                    const validation = validateFormulaSyntax(generatedText);
                    
                    if (validation.isValid) {
                        finalFormula = generatedText;
                        break; 
                    } else {
                        validationAttempts++;
                        currentPrompt = `You previously generated this formula: ${generatedText}. It resulted in the following NetSuite compilation error: ${validation.error}. Please fix the syntax, resolve the error, and return ONLY the corrected raw formula text.`;
                    }
                }

                // Prepare API Response
                if (finalFormula) {
                    responsePayload.success = true;
                    responsePayload.formula = finalFormula;
                } else {
                    responsePayload.error = "Unable to generate a syntactically valid formula after 3 iterative attempts. Please refine the input prompt.";
                }

            } catch (err) {
                responsePayload.error = "System Error: " + err.message;
            }

            // Return JSON back to the Chat UI
            context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
            context.response.write(JSON.stringify(responsePayload));
        }
    };

    return { onRequest };
});
