/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/query', 'N/https', 'N/ui/serverWidget', 'N/runtime', 'N/log'], function(query, https, serverWidget, runtime, log) {

    const GEMINI_MODEL = 'gemini-2.0-flash';

    function onRequest(context) {
        if (context.request.method === 'GET') {
            var form = serverWidget.createForm({ title: 'NetSuite AI Assistant (Gemini 2.0)' });
            var htmlField = form.addField({ id: 'custpage_html', type: 'inlinehtml', label: 'HTML' });
           
            htmlField.defaultValue = `
                <style>
                    body { font-family: -apple-system, sans-serif; padding: 20px; background-color: #f8f9fa; }
                    #chat-box { border: 1px solid #dee2e6; height: 500px; overflow-y: auto; padding: 15px; margin-bottom: 15px; background: #fff; border-radius: 10px; box-shadow: inset 0 1px 2px rgba(0,0,0,0.1); }
                    .user-msg { color: #fff; background-color: #1a73e8; margin: 10px 0 10px auto; padding: 10px 15px; border-radius: 15px 15px 0 15px; max-width: 75%; width: fit-content; clear: both; float: right; }
                    .ai-msg { color: #333; margin: 10px auto 10px 0; background: #f1f3f4; padding: 10px 15px; border-radius: 15px 15px 15px 0; max-width: 80%; width: fit-content; clear: both; float: left; border: 1px solid #e8eaed; line-height: 1.5; }
                    .error-msg { color: #d93025; background-color: #feefee; border: 1px solid #fad2cf; padding: 12px; border-radius: 8px; margin: 10px 0; clear: both; font-family: monospace; font-size: 12px; }
                    .loader { font-style: italic; color: #5f6368; margin: 10px 0; clear: both; }
                    .input-area { display: flex; gap: 10px; clear: both; }
                    input[type="text"] { flex-grow: 1; padding: 12px; border: 1px solid #dadce0; border-radius: 24px; outline: none; padding-left: 20px; }
                    button { padding: 12px 25px; cursor: pointer; background: #1a73e8; color: white; border: none; border-radius: 24px; font-weight: bold; transition: background 0.2s; }
                    button:hover { background: #1557b0; }
                </style>
                <div id="chat-box"></div>
                <div class="input-area">
                    <input type="text" id="user-input" placeholder="Ask NS assistance about your data..." onkeydown="if(event.key === 'Enter') sendMessage()">
                    <button id="send-btn" onclick="sendMessage()">Send</button>
                </div>
                <script>
                    async function sendMessage() {
                        var input = document.getElementById('user-input');
                        var box = document.getElementById('chat-box');
                        var btn = document.getElementById('send-btn');
                        var msg = input.value.trim();
                        if(!msg) return;

                        box.innerHTML += '<div class="user-msg">' + msg.replace(/</g, "&lt;") + '</div>';
                        input.value = '';
                        input.disabled = true;
                        btn.disabled = true;
                        
                        var loadingId = 'loading-' + Date.now();
                        box.innerHTML += '<div id="' + loadingId + '" class="loader">Gemini 2.0 is thinking...</div>';
                        box.scrollTop = box.scrollHeight;

                        try {
                            const response = await fetch(window.location.href, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ prompt: msg })
                            });
                            
                            const textResponse = await response.text();
                            let data;
                            try {
                                data = JSON.parse(textResponse);
                            } catch(e) {
                                throw new Error("Server returned invalid JSON: " + textResponse.substring(0, 100));
                            }

                            document.getElementById(loadingId).remove();
                            if (data.error) {
                                box.innerHTML += '<div class="error-msg"><b>System Error:</b> ' + data.error + '</div>';
                            } else {
                                box.innerHTML += '<div class="ai-msg">' + data.answer + '</div>';
                            }
                        } catch (e) {
                            if(document.getElementById(loadingId)) document.getElementById(loadingId).remove();
                            box.innerHTML += '<div class="error-msg"><b>Error:</b> ' + e.message + '</div>';
                        }
                        input.disabled = false;
                        btn.disabled = false;
                        input.focus();
                        box.scrollTop = box.scrollHeight;
                    }
                </script>
            `;
            context.response.writePage(form);
        }
        else if (context.request.method === 'POST') {
            // Ensure we return JSON headers to prevent parsing issues on the client
            context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
            
            try {
                var rawApiKey = runtime.getCurrentScript().getParameter({ name: 'custscript_open_ai_api_key' });
                if (!rawApiKey) throw new Error("Missing API Key in script parameters.");
                var apiKey = rawApiKey.trim();

                var requestBody = (typeof context.request.body === 'object') ? context.request.body : JSON.parse(context.request.body);
                var userPrompt = requestBody.prompt;

                // 1. Generate SQL
                var schema = "Transaction (id, trandate, tranid, type, total, entity, status), Customer (id, entityid, companyname, balance)";
                var systemSqlMsg = "You are a NetSuite SuiteQL expert. Translate user request to SuiteQL. Return ONLY the raw SQL. No explanations. No markdown. Use BUILTIN.DF() for names. Tables: " + schema;
                
                var sqlQuery = callGeminiAPI(systemSqlMsg + "\n\nRequest: " + userPrompt, apiKey);
                
                // Aggressive cleaning of the SQL query
                sqlQuery = sqlQuery.replace(/```sql/gi, '').replace(/```/gi, '').replace(/[\r\n]+/g, ' ').trim();

                // 2. Execute SuiteQL
                var rawResults = [];
                try {
                    var resultSet = query.runSuiteQL({ query: sqlQuery });
                    rawResults = resultSet.asMappedResults().slice(0, 10);
                } catch (sqlErr) {
                    throw new Error("SuiteQL Error. Gemini suggested: " + sqlQuery + " | Details: " + sqlErr.message);
                }

                // 3. Summarize Results
                var finalAnswer = "";
                if (rawResults.length > 0) {
                    var summaryPrompt = "Based on this NetSuite data: " + JSON.stringify(rawResults) + 
                                       "\nSummarize it to answer: " + userPrompt + 
                                       "\nUse HTML for formatting (bold, lists). Keep it concise.";
                    finalAnswer = callGeminiAPI(summaryPrompt, apiKey);
                } else {
                    finalAnswer = "I couldn't find any records for that request. (Query used: <code>" + sqlQuery + "</code>)";
                }

                context.response.write(JSON.stringify({ 
                    answer: finalAnswer, 
                    sqlUsed: sqlQuery 
                }));

            } catch (e) {
                log.error('POST Process Error', e.message);
                context.response.write(JSON.stringify({ error: e.message }));
            }
        }
    }

    /**
     * Robust Gemini API Caller with detailed logging for debugging JSON errors
     */
    function callGeminiAPI(promptText, key) {
        var baseUrl = "https://generativelanguage.googleapis.com/v1beta/models/";
        var endpoint = GEMINI_MODEL + ":generateContent?key=" + key;
        var fullUrl = baseUrl + endpoint;

        var response = https.post({
            url: fullUrl,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: { temperature: 0.1 }
            })
        });

        if (response.code !== 200) {
            log.error('Gemini API Fail', 'Status: ' + response.code + ' Body: ' + response.body);
            throw new Error("Gemini API Error (" + response.code + ")");
        }

        var resBody;
        try {
            // Trim whitespace before parsing to avoid the "non-whitespace character" error
            resBody = JSON.parse(response.body.trim());
        } catch (parseErr) {
            log.error('JSON Parse Error', 'Body received: ' + response.body);
            throw new Error("Could not parse Gemini response. See logs.");
        }

        if (resBody.candidates && resBody.candidates[0] && resBody.candidates[0].content) {
            return resBody.candidates[0].content.parts[0].text;
        } else {
            throw new Error("Gemini returned an empty result. Check Safety Filters or Quota.");
        }
    }

    return { onRequest: onRequest };
});
