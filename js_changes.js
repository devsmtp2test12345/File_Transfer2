/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * Architectural Blueprint: Autonomous Saved Search Generator (Intent-Aware Edition)
 * Enhancements: Combined Intent Analysis + RAG + Explicit Modifier Overrides.
 */

define(['N/ui/serverWidget', 'N/llm', 'N/search', 'N/query'], 
function (serverWidget, llm, search, query) {

    // --- Core Backend Utility Functions ---

    const calculateCosineSimilarity = (vecA, vecB) => {
        let dotProduct = 0;
        let normA = 0, normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += Math.pow(vecA[i], 2);
            normB += Math.pow(vecB[i], 2);
        }
        return (normA === 0 || normB === 0) ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    const getFormattedDateString = () => {
        const d = new Date();
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        let hours = d.getHours();
        let ampm = hours >= 12 ? 'PM' : 'AM';
        hours = (hours % 12) || 12;
        return `(${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${hours.toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} ${ampm}, ${d.getFullYear()})`;
    };

    // --- NEW: Intent & Modifier Analysis (Option 1 & 2 Combined) ---

    const analyzeUserIntent = (userQuery) => {
        const analysisPrompt = `Analyze this NetSuite search request: "${userQuery}". 
        Deconstruct it into a JSON object with these keys:
        - "baseSearchIntent": The core record/transaction type search (e.g., 'Purchase Order Pending Receipt'). Keep it generic for better matching.
        - "timeFilters": Specific temporal instructions (e.g., 'last week', 'yesterday', 'this month').
        - "customFields": Array of strings representing labels of custom fields mentioned.
        - "isOOD": Boolean, true if the request is NOT about NetSuite Saved Searches.
        Return ONLY the raw JSON.`;

        try {
            const response = llm.generateText({
                prompt: analysisPrompt,
                modelFamily: llm.ModelFamily.COHERE_COMMAND,
                modelParameters: { temperature: 0 }
            });
            let text = response.text.trim();
            if (text.startsWith('```')) text = text.replace(/```(json)?/gi, '').replace(/```/g, '').trim();
            return JSON.parse(text);
        } catch (e) {
            return { baseSearchIntent: userQuery, timeFilters: "", customFields: [], isOOD: false };
        }
    };

    const lookupCustomFieldIds = (fieldNames) => {
        if (!fieldNames || fieldNames.length === 0) return {};
        const mapping = {};
        try {
            const placeholders = fieldNames.map(() => '?').join(', ');
            const sql = `SELECT scriptid, name FROM customfield WHERE name IN (${placeholders})`;
            const results = query.runSuiteQL({ query: sql, params: fieldNames }).asMappedResults();
            results.forEach(res => mapping[res.name] = res.scriptid);
        } catch (e) {}
        return mapping;
    };

    const retrieveRelevantSearches = (vector) => {
        const library = [];
        const libSearch = search.create({
            type: 'customrecord_ns_savedsearches_lib',
            columns: ['custrecord_savedsearches_description', 'custrecord_savedsearches_code', 'custrecord_savedsearches_embedding']
        });
        libSearch.run().each(res => {
            const emb = res.getValue('custrecord_savedsearches_embedding');
            if (emb) {
                const score = calculateCosineSimilarity(vector, JSON.parse(emb));
                library.push({ description: res.getValue('custrecord_savedsearches_description'), code: res.getValue('custrecord_savedsearches_code'), score });
            }
            return true;
        });
        return library.sort((a, b) => b.score - a.score).slice(0, 3);
    };

    // --- UI Payload (Standard) ---

    const generateChatbotUI = (isQuotaExhausted, genQuota, embedQuota) => {
        const botGreeting = isQuotaExhausted 
            ? 'The AI Saved Search Bot is currently sleeping! 😴 Usage exhausted.' 
            : 'Hello! I am ready to build specific NetSuite Saved Searches for you. What data do you need?';
        
        return `
        <style>
            #bot-workspace { position: relative; display: flex; justify-content: center; padding: 20px; font-family: sans-serif; }
            #chat-container { width: 100%; max-width: 850px; border: 1px solid #d3d8db; border-radius: 12px; display: flex; flex-direction: column; height: 70vh; background-color: #f4f6f9; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            #chat-messages { flex-grow: 1; padding: 25px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
            .chat-message { max-width: 85%; padding: 14px; border-radius: 8px; font-size: 14px; }
            .user-msg { background-color: #607799; color: white; align-self: flex-end; }
            .bot-msg { background-color: white; border: 1px solid #e1e5e8; color: #333; align-self: flex-start; width: 95%; }
            pre { background-color: #2b303b; color: #c0c5ce; padding: 10px; border-radius: 5px; overflow-x: auto; }
            #chat-input-area { display: flex; padding: 15px; background: white; border-top: 1px solid #ddd; gap: 10px; border-radius: 0 0 12px 12px;}
            #chat-input { flex-grow: 1; padding: 10px; border: 1px solid #ccc; border-radius: 4px; }
            #send-btn { background: #4d5f7a; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; }
            .action-btn { background: #e0e6ed; border: 1px solid #ccc; padding: 5px 10px; cursor: pointer; font-size: 12px; margin-top: 5px; }
        </style>
        <div id="bot-workspace">
            <div id="chat-container">
                <div id="chat-messages"><div class="chat-message bot-msg"><strong>AI Assistant:</strong><br>${botGreeting}</div></div>
                <div id="chat-input-area">
                    <input type="text" id="chat-input" placeholder="e.g., PO pending receipts for last week" onkeypress="if(event.key==='Enter') sendQuery()" />
                    <button id="send-btn" onclick="sendQuery()">Build Search</button>
                </div>
            </div>
        </div>
        <script>
            async function sendQuery() {
                const input = document.getElementById('chat-input');
                const query = input.value.trim();
                if(!query) return;
                appendMsg(query, 'user-msg');
                input.value = '';
                const loadingId = 'L' + Date.now();
                appendMsg('Analyzing intent and retrieving templates...', 'bot-msg', loadingId);
                try {
                    const res = await fetch(window.location.href, { method: 'POST', body: JSON.stringify({query}) });
                    const data = await res.json();
                    document.getElementById(loadingId).remove();
                    if(data.success) {
                        appendHtml(\`✅ <strong>\${data.searchName}</strong> created!<br><pre>\${data.searchCode}</pre><button class="action-btn" onclick="window.open('/app/common/search/searchresults.nl?searchid=\${data.savedSearchId}')">View Results</button>\`, 'bot-msg');
                    } else {
                        appendHtml(\`❌ Error: \${data.error}\` + (data.draftCode ? \`<br><pre>\${data.draftCode}</pre>\` : ''), 'bot-msg');
                    }
                } catch(e) { appendMsg('Error: ' + e.message, 'bot-msg'); }
            }
            function appendMsg(t, c, id='') { 
                const d = document.createElement('div'); d.className='chat-message '+c; if(id) d.id=id; d.textContent=t; 
                document.getElementById('chat-messages').appendChild(d); scrollToBottom();
            }
            function appendHtml(h, c) {
                const d = document.createElement('div'); d.className='chat-message '+c; d.innerHTML=h; 
                document.getElementById('chat-messages').appendChild(d); scrollToBottom();
            }
            function scrollToBottom() { const m = document.getElementById('chat-messages'); m.scrollTop = m.scrollHeight; }
        </script>`;
    };

    // --- Main Request Handler ---

    const onRequest = (context) => {
        let genQuota = 0;
        try { genQuota = llm.getRemainingFreeUsage(); } catch(e) {}

        if (context.request.method === 'GET') {
            const form = serverWidget.createForm({ title: 'Autonomous Search Bot v2' });
            form.addField({ id: 'custpage_ui', type: serverWidget.FieldType.INLINEHTML, label: 'Chat' }).defaultValue = generateChatbotUI(genQuota <= 0, genQuota, 0);
            context.response.writePage(form);
        } else {
            let responsePayload = { success: false, error: "", searchCode: "", savedSearchId: "", searchName: "", draftCode: "" };
            try {
                const userQuery = JSON.parse(context.request.body).query;

                // STEP 1: Deconstruct Intent & Modifiers
                const analysis = analyzeUserIntent(userQuery);
                if (analysis.isOOD) {
                    responsePayload.error = "I am specialized for NetSuite Saved Searches. Please ask a search-related question.";
                    return context.response.write(JSON.stringify(responsePayload));
                }

                // STEP 2: Vectorize the INTENT (not the whole query) for cleaner RAG matching
                const queryEmb = llm.embed({ inputs: [analysis.baseSearchIntent], embedModelFamily: llm.EmbedModelFamily.COHERE_EMBED });
                const contextRecords = retrieveRelevantSearches(queryEmb.embeddings[0]);
                const ragDocs = contextRecords.map((r, i) => llm.createDocument({ id: `doc_${i}`, data: `Description: ${r.description}\nCode: ${r.code}` }));

                // STEP 3: Map Custom Fields
                const fieldMapping = lookupCustomFieldIds(analysis.customFields);

                // STEP 4: Generation with Mandatory Modifiers
                let currentPrompt = `You are a SuiteScript 2.1 Expert. 
                USER REQUEST: "${userQuery}"
                TEMPLATE GUIDANCE: Use the provided RAG documents as structural blueprints.
                
                MANDATORY MODIFICATIONS:
                - Temporal Filter: ${analysis.timeFilters || "None specified"}
                - Custom Field Mapping: ${JSON.stringify(fieldMapping)}
                
                INSTRUCTION: Generate the JSON for search.create(). If a time filter (like 'last week') was requested, you MUST add or replace the date filter in the JSON. Return ONLY raw JSON.`;

                let attempts = 0;
                while (attempts < 3) {
                    const llmGen = llm.generateText({
                        prompt: currentPrompt,
                        documents: ragDocs,
                        modelFamily: llm.ModelFamily.COHERE_COMMAND,
                        modelParameters: { temperature: 0.1, maxTokens: 1000 }
                    });

                    let jsonStr = llmGen.text.trim().replace(/```(json)?/gi, '').replace(/```/g, '').trim();
                    try {
                        const config = JSON.parse(jsonStr);
                        config.title = (config.title || "AI Search") + " " + getFormattedDateString();
                        config.id = `customsearch_ai_${new Date().getTime()}`;
                        
                        responsePayload.draftCode = JSON.stringify(config, null, 4);
                        const newSearch = search.create(config);
                        responsePayload.savedSearchId = newSearch.save();
                        responsePayload.searchName = config.title;
                        responsePayload.searchCode = responsePayload.draftCode;
                        responsePayload.success = true;
                        break;
                    } catch (e) {
                        attempts++;
                        currentPrompt = `Fix this JSON for NetSuite. Error: ${e.message}. JSON: ${jsonStr}`;
                    }
                }

                if (!responsePayload.success && !responsePayload.error) {
                    responsePayload.error = "Validation failed, but I generated a draft for you.";
                }

            } catch (err) { responsePayload.error = err.message; }
            context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
            context.response.write(JSON.stringify(responsePayload));
        }
    };

    return { onRequest };
});
