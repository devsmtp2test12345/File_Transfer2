/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/ui/serverWidget', 'N/llm'], (serverWidget, llm) => {

    /**
     * Creates a NetSuite Chatbot form specialized for generating Saved Searches.
     */
    function onRequest(context) {
        const form = serverWidget.createForm({ title: 'NetSuite Saved Search AI Generator' });
        
        // Create a field group for the chat interface
        const fieldgroup = form.addFieldGroup({ id: 'fieldgroupid', label: 'Conversation' });
        fieldgroup.isSingleColumn = true;

        // Hidden field to track the number of chat exchanges to maintain history
        const historySize = parseInt(context.request.parameters.custpage_num_chats || '0');
        const numChats = form.addField({
            id: 'custpage_num_chats',
            type: serverWidget.FieldType.INTEGER,
            container: 'fieldgroupid',
            label: 'History Size'
        });
        numChats.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

        // Define the System Persona/Prompt to make the AI a Search Expert
        const SYSTEM_PROMPT = `
            You are an expert NetSuite Developer specializing in SuiteScript 2.1 and the N/search module.
            Your goal is to help the user create NetSuite Saved Searches.
            When the user asks a question, generate the valid SuiteScript 2.1 code using 'search.create' to fulfill their request.
            Include comments explaining the filters and columns.
            If the request is unclear, ask clarifying questions about record types or criteria.
        `;

        if (context.request.method === 'POST') {
            numChats.defaultValue = historySize + 2;
            const chatHistory = [];

            // 1. Rebuild the Chat History from previous turns
            // Note: N/llm currently takes history as objects. We reconstruct it here for context.
            for (let i = historySize - 2; i >= 0; i -= 2) {
                const youField = form.addField({
                    id: 'custpage_hist' + (i + 2),
                    type: serverWidget.FieldType.TEXTAREA,
                    label: 'You',
                    container: 'fieldgroupid'
                });
                const yourMessage = context.request.parameters['custpage_hist' + i];
                youField.defaultValue = yourMessage;
                youField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

                const botField = form.addField({
                    id: 'custpage_hist' + (i + 3),
                    type: serverWidget.FieldType.TEXTAREA,
                    label: 'Search Bot',
                    container: 'fieldgroupid'
                });
                const botMessage = context.request.parameters['custpage_hist' + (i + 1)];
                botField.defaultValue = botMessage;
                botField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

                // Add to history array for the LLM context
                chatHistory.push({ role: llm.ChatRole.USER, text: yourMessage });
                chatHistory.push({ role: llm.ChatRole.CHATBOT, text: botMessage });
            }

            // 2. Handle the Current Request
            const userPrompt = context.request.parameters.custpage_text;

            // Display User's latest prompt
            const promptField = form.addField({
                id: 'custpage_hist0',
                type: serverWidget.FieldType.TEXTAREA,
                label: 'You',
                container: 'fieldgroupid'
            });
            promptField.defaultValue = userPrompt;
            promptField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

            // 3. Generate AI Response
            const resultField = form.addField({
                id: 'custpage_hist1',
                type: serverWidget.FieldType.TEXTAREA,
                label: 'Search Bot',
                container: 'fieldgroupid'
            });

            try {
                // Combine System Prompt with User Request to guide the AI
                // We prepend the system instructions to the current prompt or ensure it's in context.
                // Since N/llm chatHistory usually handles conversation, we enforce the persona in the prompt for best results in single-turn logic
                // or rely on the model's inherent capabilities if trained on NetSuite data. 
                // A strong prompt prefix works best here.
                const fullPrompt = `${SYSTEM_PROMPT}\n\nUser Request: ${userPrompt}`;

                const aiResponse = llm.generateText({
                    prompt: fullPrompt,
                    chatHistory: chatHistory
                });

                resultField.defaultValue = aiResponse.text;
            } catch (e) {
                resultField.defaultValue = "Error generating response: " + e.message;
            }
            resultField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

        } else {
            // Initial Load
            numChats.defaultValue = 0;
            const intro = form.addField({
                id: 'custpage_intro',
                type: serverWidget.FieldType.HELP,
                label: 'Welcome',
                container: 'fieldgroupid'
            });
            // Explanation for the user
            intro.label = "Ask me to create a Saved Search! (e.g., 'Find all customers in California who haven't ordered in 6 months')";
        }

        // Input field for new prompts
        form.addField({
            id: 'custpage_text',
            type: serverWidget.FieldType.TEXTAREA,
            label: 'Describe your Search',
            container: 'fieldgroupid'
        });

        form.addSubmitButton({ label: 'Generate Search' });

        context.response.writePage(form);
    }

    return { onRequest: onRequest };
});