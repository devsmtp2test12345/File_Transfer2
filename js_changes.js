/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/ui/serverWidget', 'N/https', 'N/runtime', 'N/log', 'N/search', 'N/url'], (serverWidget, https, runtime, log, search, url) => {

    const GEMINI_MODEL = 'gemini-2.5-flash';

    function onRequest(context) {
        // 1. Setup UI (GET)
        if (context.request.method === 'GET') {
            const form = serverWidget.createForm({ title: 'NetSuite Search Auto-Creator' });
            const htmlField = form.addField({ id: 'custpage_html', type: 'inlinehtml', label: 'HTML' });
            
            // Using the robust HTML/CSS structure from your provided logic
            htmlField.defaultValue = `
                <style>
                    body { font-family: -apple-system, sans-serif; padding: 20px; background-color: #f8f9fa; }
                    #chat-box { border: 1px solid #dee2e6; height: 450px; overflow-y: auto; padding: 15px; margin-bottom: 15px; background: #fff; border-radius: 10px; box-shadow: inset 0 1px 2px rgba(0,0,0,0.1); }
                    .user-msg { color: #fff; background-color: #1a73e8; margin: 10px 0 10px auto; padding: 10px 15px; border-radius: 15px 15px 0 15px; max-width: 75%; width: fit-content; clear: both; float: right; }
                    .ai-msg { color: #333; margin: 10px auto 10px 0; background: #f1f3f4; padding: 10px 15px; border-radius: 15px 15px 15px 0; max-width: 80%; width: fit-content; clear: both; float: left; border: 1px solid #e8eaed; line-height: 1.5; }
                    .error-msg { color: #d93025; background-color: #feefee; border: 1px solid #fad2cf; padding: 12px; border-radius: 8px; margin: 10px 0; clear: both; font-family: monospace; font-size: 12px; }
                    .loader { font-style: italic; color: #5f6368; margin: 10px 0; clear: both; }
                    .input-area { display: flex; gap: 10px; clear: both; }
                    input[type="text"] { flex-grow: 1; padding: 12px; border: 1px solid #dadce0; border-radius: 24px; outline: none; padding-left: 20px; }
                    button { padding: 12px 25px; cursor: pointer; background: #1a73e8; color: white; border: none; border-radius: 24px; font-weight: bold; transition: background 0.2s; }
                    button:hover { background: #1557b0; }
                    .search-link { display: inline-block; margin-top: 5px; color: #1a73e8; text-decoration: underline; font-weight: 600; }
                </style>
                <div id="chat-box">
                    <div class="ai-msg">I can create and save searches for you. Example: "Save a search for all Customers in California."</div>
                </div>
                <div class="input-area">
                    <input type="text" id="user-input" placeholder="Describe the search to save..." onkeydown="if(event.key === 'Enter') sendMessage()">
                    <button id="send-btn" onclick="sendMessage()">Create & Save</button>
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
                        input.disabled = true; btn.disabled = true;
                        
                        var loadingId = 'loading-' + Date.now();
                        box.innerHTML += '<div id="' + loadingId + '" class="loader">Gemini is configuring NetSuite...</div>';
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
                                throw new Error("Server returned invalid JSON.");
                            }

                            document.getElementById(loadingId).remove();
                            if (data.error) {
                                box.innerHTML += '<div class="error-msg"><b>Error:</b> ' + data.error + '</div>';
                            } else {
                                box.innerHTML += '<div class="ai-msg">' + data.answer + '</div>';
                            }
                        } catch (e) {
                            if(document.getElementById(loadingId)) document.getElementById(loadingId).remove();
                            box.innerHTML += '<div class="error-msg"><b>Connection Error:</b> ' + e.message + '</div>';
                        }
                        input.disabled = false; btn.disabled = false;
                        input.focus();
                        box.scrollTop = box.scrollHeight;
                    }
                </script>
            `;
            context.response.writePage(form);
        }
        
        // 2. Handle Logic (POST)
        else if (context.request.method === 'POST') {
            context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
            
            try {
                // Validate API Key
                const scriptObj = runtime.getCurrentScript();
                const rawApiKey = scriptObj.getParameter({ name: 'custscript_open_ai_api_key' });
                if (!rawApiKey) throw new Error("Missing API Key (custscript_open_ai_api_key) in script parameters.");
                const apiKey = rawApiKey.trim();

                const requestBody = (typeof context.request.body === 'object') ? context.request.body : JSON.parse(context.request.body);
                const userPrompt = requestBody.prompt;

                // 3. AI Prompt Construction
                const systemPrompt = "You are a NetSuite system helper. " +
                                     "Convert the user request into a JSON object for 'search.create()'. " +
                                     "Include 'type', 'filters', 'columns', and a 'title'. " +
                                     "The 'title' must start with 'AI Generated: '. " +
                                     "Return ONLY the raw JSON object. NO markdown (no ```json).";
                
                const aiResponseRaw = callGeminiAPI(systemPrompt + "\n\nUser Request: " + userPrompt, apiKey);

                // 4. Clean and Parse JSON
                // Robust cleaning similar to your SuiteQL logic
                const cleanJson = aiResponseRaw.replace(/```json/g, "").replace(/```/g, "").replace(/JSON/g, "").trim();
                
                let searchConfig;
                try {
                    searchConfig = JSON.parse(cleanJson);
                } catch (jsonErr) {
                    throw new Error("AI returned invalid JSON. Raw response: " + cleanJson.substring(0, 50) + "...");
                }

                // 5. Create and Save Search
                let searchId;
                try {
                    const newSearch = search.create(searchConfig);
                    searchId = newSearch.save();
                } catch (searchErr) {
                    throw new Error("NetSuite rejected the search criteria: " + searchErr.message);
                }

                // 6. Generate Link (FIXED: Using Relative URL)
                // This resolves to something like "/app/common/search/savedsearch.nl?id=123"
                // It avoids the "fully qualified URL" error because we don't use resolveDomain.
                const relativePath = url.resolveRecord({
                    recordType: 'savedsearch',
                    recordId: searchId,
                    isEditMode: false
                });

                const finalAnswer = "Success! I saved the search <b>" + searchConfig.title + "</b>.<br>" +
                                    "<a href='" + relativePath + "' target='_blank' class='search-link'>Click here to open it</a>";

                context.response.write(JSON.stringify({ 
                    answer: finalAnswer, 
                    id: searchId 
                }));

            } catch (e) {
                log.error('POST Process Error', e.message);
                context.response.write(JSON.stringify({ error: e.message }));
            }
        }
    }

    /**
     * Robust Gemini API Caller
     */
    function callGeminiAPI(promptText, key) {
        const baseUrl = "https://generativelanguage.googleapis.com/v1beta/models/";
        const endpoint = GEMINI_MODEL + ":generateContent?key=" + key;
        const fullUrl = baseUrl + endpoint;

        const response = https.post({
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

        let resBody;
        try {
            resBody = JSON.parse(response.body.trim());
        } catch (parseErr) {
            log.error('JSON Parse Error', 'Body: ' + response.body);
            throw new Error("Could not parse AI response.");
        }

        if (resBody.candidates && resBody.candidates[0].content) {
            return resBody.candidates[0].content.parts[0].text;
        } else {
            throw new Error("AI returned empty result.");
        }
    }

    return { onRequest: onRequest };
});
