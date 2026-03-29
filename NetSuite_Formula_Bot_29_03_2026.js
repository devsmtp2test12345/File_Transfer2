/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * * Architectural Blueprint: High-Accuracy Formula Generator BOT (Chat UI Edition)
 * Utilizes N/llm, Retrieval-Augmented Generation (RAG), programmatic search validation,
 * dynamic Record schema and Data Type introspection, Chain of Thought (CoT) self-correction,
 * Few-Shot Prompting, collapsible usage quota limits, and an asynchronous frontend.
 */

define(['N/ui/serverWidget', 'N/llm', 'N/search', 'N/query', 'N/record'], 
function (serverWidget, llm, search, query, record) {

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

    // --- Dynamic Record Schema Backend Functions ---

    const identifyTargetRecordType = (userQuery) => {
        const extractionPrompt = `Analyze the following NetSuite formula request. Identify the specific NetSuite internal record type ID (e.g., 'salesorder', 'customer', 'employee', 'invoice') implied by the query. Do NOT return abstract types like 'transaction', guess the specific concrete type if necessary. Return ONLY the single word internal ID in lowercase, or 'UNKNOWN' if it cannot be determined. Request: "${userQuery}"`;
        
        try {
            const llmResponse = llm.generateText({
                prompt: extractionPrompt,
                modelFamily: llm.ModelFamily.COHERE_COMMAND,
                modelParameters: { temperature: 0.1 }
            });
            
            let recordType = llmResponse.text.trim().toLowerCase();
            return recordType.replace(/['"`]/g, '').replace(/```(json)?/g, '').trim();
        } catch (e) {
            return 'unknown'; 
        }
    };

    const getAvailableFieldsForRecord = (recordType) => {
        if (!recordType || recordType === 'unknown') return null;
        try {
            const dummyRec = record.create({ type: recordType });
            const fields = dummyRec.getFields();
            const fieldDataTypes = {};

            // Iterate through fields to extract their specific NetSuite data types
            fields.forEach(fieldId => {
                try {
                    const fieldObj = dummyRec.getField({ fieldId: fieldId });
                    if (fieldObj && fieldObj.type) {
                        fieldDataTypes[fieldId] = fieldObj.type;
                    } else {
                        fieldDataTypes[fieldId] = 'unknown';
                    }
                } catch (err) {
                    // Skip fields that throw errors during API introspection
                }
            });

            return fieldDataTypes;
        } catch (e) {
            return null;
        }
    };

    // --- UI HTML/CSS/JS Payload ---

    const generateChatbotUI = (isQuotaExhausted, genQuota, embedQuota) => {
        const botGreeting = isQuotaExhausted 
            ? 'The AI Formula BOT is currently sleeping! 😴 We have exhausted our free NetSuite AI usage for the month. Please check back on the 1st.' 
            : 'Hello! I am ready to generate and validate complex saved search formulas for you. What logic do you need help writing today?';
        
        const disableInputAttr = isQuotaExhausted ? 'disabled' : '';
        const placeholderText = isQuotaExhausted ? 'Quota exhausted. BOT unavailable.' : 'e.g., Calculate days between date created and closed on a Sales Order...';

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
            .copy-btn { background-color: #e0e6ed; color: #333; border: 1px solid #cdd4dc; padding: 8px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; transition: all 0.2s; }
            .copy-btn:hover { background-color: #d1d8e0; }
            #chat-input-area { display: flex; padding: 15px 20px; background-color: white; border-top: 1px solid #d3d8db; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; align-items: center; gap: 10px; }
            #chat-input { flex-grow: 1; padding: 12px 15px; border: 1px solid #cdd4dc; border-radius: 6px; font-size: 14px; outline: none; transition: border-color 0.2s; }
            #chat-input:focus { border-color: #607799; }
            #chat-input:disabled { background-color: #f0f2f5; cursor: not-allowed; }
            #send-btn { background-color: #4d5f7a; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: bold; transition: background-color 0.2s; }
            #send-btn:hover { background-color: #3b495e; }
            #send-btn:disabled { background-color: #a0abbc; cursor: not-allowed; }
            .typing-indicator { font-style: italic; color: #7f8c8d; font-size: 13px; }
            .system-note { font-size: 11px; color: #7f8c8d; margin-top: -10px; margin-bottom: 10px; text-align: left; padding-left: 5px; }
        </style>

        <div id="bot-workspace">
            <div class="quota-badge">
                <div class="quota-header-row" onclick="toggleQuotaDetails()">
                    <div class="quota-header">⚡ Remaining AI Usage : ${genQuota} Gen | ${embedQuota} emb</div>
                    <div class="quota-toggle" id="quota-toggle-icon">▼</div>
                </div>
                <div class="quota-details" id="quota-details-content">
                    <strong style="color: #333;">Gen (Word Generation):</strong> The AI has the capacity to write approximately <strong>${genQuota}</strong> more words, code snippets, or formulas for you this month.<br><br>
                    <strong style="color: #333;">Embed (Deep Searching):</strong> The AI can perform <strong>${embedQuota}</strong> more intelligent background searches into the NetSuite database to understand your specific requests this month.
                </div>
            </div>
            
            <div id="chat-container">
                <div id="chat-messages">
                    <div class="chat-message bot-msg">
                        <strong>NetSuite AI Formula BOT</strong><br>
                        ${botGreeting}
                    </div>
                </div>
                <div id="chat-input-area">
                    <input type="text" id="chat-input" placeholder="${placeholderText}" onkeypress="if(event.key === 'Enter') sendQuery()" ${disableInputAttr} />
                    <button type="button" id="send-btn" onclick="sendQuery()" ${disableInputAttr}>Generate</button>
                </div>
            </div>
        </div>

        <script>
            // UI Toggle Logic
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

            // Core Chat Logic
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
                appendMessage('Thinking, scanning record schema & data types, and compiling formula against NetSuite search engine...', 'bot-msg typing-indicator', loadingId);

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
                        
                        const schemaContextNote = data.identifiedRecord !== 'unknown' 
                            ? \`<div class="system-note">🔍 Introspected schema & data types for '\${data.identifiedRecord}' record to ensure accuracy.</div>\` 
                            : '';

                        const htmlResponse = \`
                            \${schemaContextNote}
                            <strong>Validated Formula Generated:</strong>
                            <pre id="\${formulaId}">\${escapeHtml(data.formula)}</pre>
                            <button type="button" class="copy-btn" onclick="copyToClipboard('\${formulaId}', this)">
                                📋 Copy Formula
                            </button>
                        \`;
                        appendHtmlMessage(htmlResponse, 'bot-msg');
                    } else {
                        let errorPrefix = '❌ Validation Failed: ';
                        if (data.error.includes("specialized NetSuite AI Formula BOT")) {
                            errorPrefix = '🤖 Notice: ';
                        }
                        appendMessage(errorPrefix + data.error, 'bot-msg');
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
        // Evaluate AI Usage Quotas
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
            // Render the Chat UI wrapper
            const form = serverWidget.createForm({ title: 'AI Formula Assistant', hideNavBar: false });
            
            const htmlField = form.addField({
                id: 'custpage_chat_ui',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Chat UI'
            });
            
            htmlField.defaultValue = generateChatbotUI(isQuotaExhausted, genQuota, embedQuota);
            context.response.writePage(form);
            
        } else if (context.request.method === 'POST') {
            let responsePayload = { success: false, formula: '', error: '', identifiedRecord: 'unknown' };

            if (isQuotaExhausted) {
                responsePayload.error = "The AI Formula BOT is currently sleeping! 😴 We have exhausted our free NetSuite AI usage for the month. Please check back on the 1st.";
                context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
                context.response.write(JSON.stringify(responsePayload));
                return; 
            }

            try {
                const requestBody = JSON.parse(context.request.body);
                const userQuery = requestBody.query;

                let finalFormula = '';
                let validationAttempts = 0;
                const maxAttempts = 3;

                // --- Architectural Step 0.5: Determine User Intention ---
                let userIntention = "";
                try {
                    const intentionPrompt = `Analyze the following NetSuite formula request and describe the primary core intention, logic, or mathematical operation the user wants to achieve in one concise sentence. Do not include introductory text. Request: "${userQuery}"`;
                    
                    const intentionResponse = llm.generateText({
                        prompt: intentionPrompt,
                        modelFamily: llm.ModelFamily.COHERE_COMMAND,
                        modelParameters: { temperature: 0.1 }
                    });
                    userIntention = intentionResponse.text.trim();
                } catch (intentionErr) {
                    userIntention = "";
                }

                const enrichedQuery = userIntention ? `${userQuery} Intention: ${userIntention}` : userQuery;

                // --- Architectural Step 1: Vectorize the enriched natural language query ---
                const queryEmbeddingResponse = llm.embed({
                    inputs: [enrichedQuery],
                    embedModelFamily: llm.EmbedModelFamily.COHERE_EMBED
                });
                const userQueryVector = queryEmbeddingResponse.embeddings[0]; 

                // --- Architectural Step 2: RAG Retrieval ---
                const contextRecords = retrieveRelevantFormulas(userQueryVector);
                const ragDocuments = contextRecords.map((rec, index) => {
                    return llm.createDocument({
                        id: `doc_${index}`,
                        data: `Description: ${rec.description}\nSyntax: ${rec.syntax}`
                    });
                });

                // --- Architectural Step 2.5: Dynamic Record Schema & Type Introspection ---
                let availableFieldsText = "";
                const targetRecordType = identifyTargetRecordType(userQuery);
                responsePayload.identifiedRecord = targetRecordType;

                if (targetRecordType !== 'unknown') {
                    const validFieldTypes = getAvailableFieldsForRecord(targetRecordType);
                    if (validFieldTypes && Object.keys(validFieldTypes).length > 0) {
                        availableFieldsText = `\nCRITICAL CONTEXT: The target NetSuite record is '${targetRecordType}'. Here is a JSON dictionary mapping valid field internal IDs to their NetSuite Data Types: ${JSON.stringify(validFieldTypes)}. You MUST strictly use matching internal IDs from this dictionary. Pay close attention to the Data Types: do NOT perform mathematical operations between mismatched types (e.g., subtracting a 'text' field from a 'date') without using appropriate Oracle SQL conversion functions like TO_DATE, TO_NUMBER, or TO_CHAR.`;
                    }
                }

                // --- Architectural Step 3: Generation with Few-Shot, CoT Self-Correction & Guardrails ---
                const fewShotExamples = `
GOLDEN EXAMPLES OF CORRECT NETSUITE FORMULAS:
1. Date Math (Handle Nulls): Request: "Calculate days between date created and closed. If not closed, use today." -> Formula: ROUND(NVL({dateclosed}, SYSDATE) - {datecreated})
2. Safe Division (Prevent Errors): Request: "Calculate margin (profit / revenue) but handle zero revenue." -> Formula: CASE WHEN NVL({revenue}, 0) = 0 THEN 0 ELSE ({profit} / NULLIF({revenue}, 0)) * 100 END
3. Type Conversion (Concat): Request: "Combine document number and transaction date." -> Formula: {tranid} || ' - ' || TO_CHAR({trandate}, 'YYYY-MM-DD')
`;

                // CRITICAL FIX: Instructed the LLM to use its internal general knowledge of Oracle/NetSuite PLSQL as a primary driver,
                // and to treat RAG documents purely as helpful reference materials, unblocking logic not present in the DB.
                let currentPrompt = `You are a strict NetSuite PL/SQL expert BOT. Analyze the request: "${userQuery}". If this request is a general question, conversational filler, or completely unrelated to NetSuite, saved searches, database logic, or formula generation, reply with the exact text: "OOD_REQUEST". Otherwise, write a NetSuite saved search formula for the request.\n\nCRITICAL INSTRUCTION: Use the provided retrieved documents as a helpful reference, but you MUST rely on your inherent extensive knowledge of NetSuite and Oracle SQL to generate the formula if the exact logic is not found in the documents. Do not be limited by the provided documents.\n\n${fewShotExamples}${availableFieldsText}\nReturn ONLY the raw formula text (or "OOD_REQUEST"). No markdown, no conversational text.`;

                while (validationAttempts < maxAttempts) {
                    const llmResponse = llm.generateText({
                        prompt: currentPrompt,
                        documents: ragDocuments, 
                        modelFamily: llm.ModelFamily.COHERE_COMMAND, 
                        modelParameters: { temperature: 0.1, maxTokens: 1000 }
                    });

                    let generatedResponse = llmResponse.text.trim();
                    
                    if (generatedResponse.includes('OOD_REQUEST')) {
                        responsePayload.error = "I am a specialized NetSuite AI Formula BOT. I can only answer questions and generate logic related to NetSuite saved searches formulas. Please ask me a formula-related question!";
                        break; 
                    }

                    // CoT Extraction: Extract formula from tags if present (applies to retry loops)
                    let formulaToValidate = generatedResponse;
                    const tagMatch = generatedResponse.match(/<formula>([\s\S]*?)<\/formula>/i);
                    if (tagMatch) {
                        formulaToValidate = tagMatch[1].trim();
                    } else {
                        // Fallback: Strip markdown block formatting if the LLM ignores tags
                        formulaToValidate = formulaToValidate.replace(/```(sql)?/gi, '').trim();
                    }
                    
                    const validation = validateFormulaSyntax(formulaToValidate);
                    
                    if (validation.isValid) {
                        finalFormula = formulaToValidate;
                        break; 
                    } else {
                        validationAttempts++;
                        // Activate Chain of Thought (CoT) prompting for the correction attempt
                        currentPrompt = `You previously generated this formula: ${formulaToValidate}\n\nIt resulted in the following NetSuite compilation error: "${validation.error}".\n\nFirst, carefully THINK about this error. Write one concise sentence explaining exactly why Oracle SQL or NetSuite rejected the syntax based on the error message and the Data Types context provided.\nThen, provide the corrected raw formula wrapped exactly in <formula> and </formula> tags. Do not add markdown inside the tags.`;
                    }
                }

                // Prepare API Response
                if (finalFormula) {
                    responsePayload.success = true;
                    responsePayload.formula = finalFormula;
                } else if (!responsePayload.error) {
                    responsePayload.error = "Unable to generate a syntactically valid formula after 3 iterative attempts. Please verify your requested logic and field names.";
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