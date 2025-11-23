const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    let snippetManager = null;

    // Register Command FIRST to ensure it's always available
    let currentPanel = undefined;

    let disposable = vscode.commands.registerCommand('snippet-library.openEditor', () => {
        if (!snippetManager) {
            vscode.window.showErrorMessage('Snippet Library failed to initialize. Please check the "Developer: Toggle Developer Tools" console for errors.');
            return;
        }

        if (currentPanel) {
            currentPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        currentPanel = vscode.window.createWebviewPanel(
            'snippetEditor',
            'Snippet Library Editor',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        currentPanel.webview.html = getWebviewContent();

        currentPanel.onDidDispose(
            () => {
                currentPanel = undefined;
            },
            null,
            context.subscriptions
        );

        currentPanel.webview.onDidReceiveMessage(
            async message => {
                try {
                    switch (message.command) {
                        case 'getSnippets':
                            sendSnippets(currentPanel, snippetManager);
                            break;
                        case 'saveSnippet':
                            await saveSnippet(message.data, snippetManager);
                            sendSnippets(currentPanel, snippetManager);
                            vscode.window.showInformationMessage('Snippet saved successfully!');
                            break;
                        case 'deleteSnippet':
                            // Show native confirmation dialog
                            const answer = await vscode.window.showWarningMessage(
                                `Are you sure you want to delete snippet "${message.data.name}"?`,
                                { modal: true },
                                'Yes'
                            );
                            if (answer === 'Yes') {
                                await deleteSnippet(message.data, snippetManager);
                                sendSnippets(currentPanel, snippetManager);
                                vscode.window.showInformationMessage('Snippet deleted successfully!');
                            }
                            break;
                        case 'insertSnippet':
                            await insertSnippet(message.data);
                            break;
                        case 'backupSnippets':
                            await backupSnippets(snippetManager);
                            break;
                        case 'restoreSnippets':
                            await restoreSnippets(snippetManager, currentPanel);
                            break;
                        case 'addLanguage':
                            await addLanguage(snippetManager, context.extensionPath, currentPanel);
                            break;
                    }
                } catch (error) {
                    vscode.window.showErrorMessage('Error processing command: ' + error.message);
                }
            },
            undefined,
            context.subscriptions
        );
    });

    context.subscriptions.push(disposable);

    // Initialize Core Logic with Error Handling
    try {
        snippetManager = new SnippetManager(context.extensionPath);
        
        // Register Completion Provider
        const provider = new SnippetCompletionProvider(snippetManager);
        const languages = snippetManager.getLanguageIds();
        
        if (languages.length > 0) {
            context.subscriptions.push(
                vscode.languages.registerCompletionItemProvider(languages, provider)
            );
        }
        
        console.log('Snippet Library initialized successfully.');
    } catch (e) {
        console.error('Snippet Library Initialization Error:', e);
        vscode.window.showErrorMessage('Snippet Library failed to activate: ' + e.message);
    }
}

class SnippetManager {
    constructor(extensionPath) {
        this.extensionPath = extensionPath;
        this.snippets = {};
        this.refresh();
    }

    getSnippetFiles() {
        const snippetsDir = path.join(this.extensionPath, 'snippets');
        if (!fs.existsSync(snippetsDir)) {
            fs.mkdirSync(snippetsDir);
        }

        const files = {};
        const items = fs.readdirSync(snippetsDir);
        
        items.forEach(item => {
            if (item.endsWith('.json')) {
                const lang = item.replace('.json', '');
                files[lang] = path.join(snippetsDir, item);
            }
        });

        return files;
    }

    getLanguageIds() {
        return Object.keys(this.getSnippetFiles());
    }

    refresh() {
        const files = this.getSnippetFiles();
        this.snippets = {}; // Reset
        for (const [lang, filePath] of Object.entries(files)) {
            if (fs.existsSync(filePath)) {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    this.snippets[lang] = JSON.parse(content);
                } catch (e) {
                    console.error(`Error reading ${lang} snippets:`, e);
                    this.snippets[lang] = {};
                }
            } else {
                this.snippets[lang] = {};
            }
        }
    }

    getSnippets(language) {
        return this.snippets[language] || {};
    }

    getAllSnippets() {
        return this.snippets;
    }
}

class SnippetCompletionProvider {
    constructor(snippetManager) {
        this.snippetManager = snippetManager;
    }

    provideCompletionItems(document, position, token, context) {
        const lang = document.languageId;
        // Map javascriptreact to javascript snippets if needed
        const targetLang = lang === 'javascriptreact' ? 'javascript' : lang;
        
        const snippets = this.snippetManager.getSnippets(targetLang);
        const globalSnippets = this.snippetManager.getSnippets('global');
        
        const items = [];

        const addSnippets = (sourceSnippets, isGlobal = false) => {
            for (const [name, data] of Object.entries(sourceSnippets)) {
                const item = new vscode.CompletionItem(data.prefix, vscode.CompletionItemKind.Snippet);
                item.detail = isGlobal ? `${name} (Global)` : name;
                item.documentation = new vscode.MarkdownString(data.description || '');
                
                let body = data.body;
                if (Array.isArray(body)) {
                    body = body.join('\n');
                }
                item.insertText = new vscode.SnippetString(body);
                items.push(item);
            }
        };

        addSnippets(snippets);
        addSnippets(globalSnippets, true);

        return items;
    }
}

function sendSnippets(panel, snippetManager) {
    if (snippetManager) {
        panel.webview.postMessage({ command: 'loadSnippets', data: snippetManager.getAllSnippets() });
    }
}

async function saveSnippet(data, snippetManager) {
    const { language, originalName, newName, prefix, body, description } = data;
    const files = snippetManager.getSnippetFiles();
    let filePath = files[language];

    // Handle 'global' specifically if it doesn't exist yet
    if (!filePath && language === 'global') {
        filePath = path.join(snippetManager.extensionPath, 'snippets', 'global.json');
        // Ensure directory exists
        const snippetsDir = path.dirname(filePath);
        if (!fs.existsSync(snippetsDir)) {
            fs.mkdirSync(snippetsDir);
        }
    }

    if (!filePath) return;

    let snippets = {};
    if (fs.existsSync(filePath)) {
        try {
            snippets = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            snippets = {};
        }
    }

    if (originalName && originalName !== newName && snippets[originalName]) {
        delete snippets[originalName];
    }

    snippets[newName] = {
        prefix: prefix,
        body: typeof body === 'string' ? body.split('\n') : body,
        description: description
    };

    fs.writeFileSync(filePath, JSON.stringify(snippets, null, 2), 'utf8');
    snippetManager.refresh();
}

async function deleteSnippet(data, snippetManager) {
    const { language, name } = data;
    const files = snippetManager.getSnippetFiles();
    const filePath = files[language];

    if (!filePath || !fs.existsSync(filePath)) return;

    try {
        const snippets = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (snippets[name]) {
            delete snippets[name];
            fs.writeFileSync(filePath, JSON.stringify(snippets, null, 2), 'utf8');
            snippetManager.refresh();
        }
    } catch (e) {
        console.error('Error deleting snippet:', e);
    }
}

async function insertSnippet(data) {
    const { body } = data;
    let editor = vscode.window.activeTextEditor;
    
    if (!editor) {
        const visible = vscode.window.visibleTextEditors;
        if (visible.length > 0) {
            editor = visible[0];
        }
    }

    if (editor) {
        const snippetString = Array.isArray(body) ? body.join('\n') : body;
        await editor.insertSnippet(new vscode.SnippetString(snippetString));
    } else {
        vscode.window.showErrorMessage('Please open a text editor to insert the snippet.');
    }
}

async function backupSnippets(snippetManager) {
    const snippets = snippetManager.getAllSnippets();
    const content = JSON.stringify(snippets, null, 2);
    
    const uri = await vscode.window.showSaveDialog({
        filters: {
            'JSON': ['json']
        },
        saveLabel: 'Backup Snippets'
    });

    if (uri) {
        fs.writeFileSync(uri.fsPath, content, 'utf8');
        vscode.window.showInformationMessage('Snippets backed up successfully!');
    }
}

async function restoreSnippets(snippetManager, panel) {
    const answer = await vscode.window.showWarningMessage(
        'Restoring will merge/overwrite existing snippets. Do you want to continue?',
        'Yes', 'No'
    );

    if (answer !== 'Yes') return;

    const uri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
            'JSON': ['json']
        },
        openLabel: 'Restore Snippets'
    });

    if (uri && uri[0]) {
        try {
            const content = fs.readFileSync(uri[0].fsPath, 'utf8');
            const backup = JSON.parse(content);
            const files = snippetManager.getSnippetFiles();

            // Distribute snippets to their respective files
            for (const [lang, snippets] of Object.entries(backup)) {
                // Create file if it doesn't exist (for restored languages)
                let filePath = files[lang];
                if (!filePath) {
                    filePath = path.join(snippetManager.extensionPath, 'snippets', `${lang}.json`);
                }

                let currentSnippets = {};
                if (fs.existsSync(filePath)) {
                    currentSnippets = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                }
                
                const merged = { ...currentSnippets, ...snippets };
                fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
            }

            snippetManager.refresh();
            sendSnippets(panel, snippetManager);
            vscode.window.showInformationMessage('Snippets restored successfully!');
        } catch (e) {
            vscode.window.showErrorMessage('Error restoring snippets: ' + e.message);
        }
    }
}

async function addLanguage(snippetManager, extensionPath, panel) {
    const languageId = await vscode.window.showInputBox({
        placeHolder: 'e.g., python, go, ruby',
        prompt: 'Enter the language ID to add support for'
    });

    if (!languageId) return;
    
    const cleanId = languageId.toLowerCase().trim();
    const filePath = path.join(extensionPath, 'snippets', `${cleanId}.json`);

    if (fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`Language "${cleanId}" already exists.`);
        return;
    }

    // Create empty snippet file
    fs.writeFileSync(filePath, '{}', 'utf8');
    snippetManager.refresh();

    // Update package.json activation events
    const packageJsonPath = path.join(extensionPath, 'package.json');
    try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const event = `onLanguage:${cleanId}`;
        if (!packageJson.activationEvents.includes(event)) {
            packageJson.activationEvents.push(event);
            fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
            vscode.window.showInformationMessage(`Language "${cleanId}" added. Please reload window for auto-complete to work fully.`);
        }
    } catch (e) {
        console.error('Error updating package.json:', e);
    }
    
    sendSnippets(panel, snippetManager);
}

function getWebviewContent() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Snippet Library Editor</title>
    <style>
        :root {
            --container-paddding: 20px;
            --input-padding-vertical: 6px;
            --input-padding-horizontal: 4px;
            --input-margin-vertical: 4px;
            --input-margin-horizontal: 0;
        }

        body {
            padding: 0;
            margin: 0;
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            display: flex;
            height: 100vh;
            overflow: hidden;
        }

        .sidebar {
            width: 250px;
            background-color: var(--vscode-sideBar-background);
            border-right: 1px solid var(--vscode-sideBar-border);
            display: flex;
            flex-direction: column;
        }

        .sidebar-header {
            padding: 10px;
            font-weight: bold;
            text-transform: uppercase;
            font-size: 11px;
            background-color: var(--vscode-sideBarSectionHeader-background);
            color: var(--vscode-sideBarSectionHeader-foreground);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header-actions {
            display: flex;
            gap: 5px;
        }

        .icon-btn {
            background: none;
            border: none;
            color: var(--vscode-icon-foreground);
            cursor: pointer;
            padding: 2px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
        }

        .icon-btn:hover {
            color: var(--vscode-foreground);
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .language-list {
            list-style: none;
            padding: 0;
            margin: 0;
            overflow-y: auto;
            flex: 0 0 auto;
            max-height: 30%;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .language-item {
            padding: 8px 15px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .language-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .language-item.active {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        .add-snippet-btn {
            background: none;
            border: none;
            color: inherit;
            cursor: pointer;
            opacity: 0;
            font-weight: bold;
            padding: 0 5px;
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .language-item:hover .add-snippet-btn,
        .language-item.active .add-snippet-btn {
            opacity: 1;
        }
        
        .add-snippet-btn:hover {
            background-color: rgba(255, 255, 255, 0.2);
            border-radius: 3px;
        }

        .snippet-list-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .search-box {
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .search-input {
            width: 100%;
            padding: 6px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            box-sizing: border-box;
        }

        .snippet-list {
            list-style: none;
            padding: 0;
            margin: 0;
            overflow-y: auto;
            flex: 1;
        }

        .snippet-item {
            padding: 8px 15px;
            cursor: pointer;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .snippet-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .snippet-item.active {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        .snippet-info {
            flex: 1;
            overflow: hidden;
        }

        .snippet-name {
            font-weight: bold;
            display: block;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .snippet-prefix {
            font-size: 0.85em;
            opacity: 0.8;
        }

        .insert-btn {
            background: none;
            border: 1px solid var(--vscode-button-background);
            color: var(--vscode-button-background);
            border-radius: 3px;
            padding: 2px 6px;
            font-size: 10px;
            cursor: pointer;
            margin-left: 5px;
            opacity: 0.6;
            transition: all 0.2s;
        }

        .insert-btn:hover {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            opacity: 1;
        }

        .main-content {
            flex: 1;
            padding: 20px;
            display: flex;
            flex-direction: column;
            overflow-y: auto;
        }

        .editor-form {
            display: flex;
            flex-direction: column;
            gap: 15px;
            max-width: 800px;
        }

        .form-group {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }

        label {
            font-weight: bold;
            font-size: 0.9em;
        }

        input, textarea {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }

        textarea {
            min-height: 300px;
            resize: vertical;
        }

        .toolbar {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
        }

        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        button.danger {
            background-color: var(--vscode-errorForeground);
        }

        .empty-state {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
            font-size: 1.2em;
        }

        .hidden {
            display: none !important;
        }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="sidebar-header">
            Languages
            <div class="header-actions">
                <button class="icon-btn" id="addLangBtn" title="Add Language"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M12 3.75a.75.75 0 0 1 .75.75v6.75h6.75a.75.75 0 0 1 0 1.5h-6.75v6.75a.75.75 0 0 1-1.5 0v-6.75H4.5a.75.75 0 0 1 0-1.5h6.75V4.5a.75.75 0 0 1 .75-.75Z"/></svg></button>
                <button class="icon-btn" id="backupBtn" title="Backup Snippets"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M12 2.25a.75.75 0 0 1 .75.75v11.69l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 1 1 1.06-1.06l3.22 3.22V3a.75.75 0 0 1 .75-.75Zm-9 13.5a.75.75 0 0 1 .75.75v2.25a1.5 1.5 0 0 0 1.5 1.5h13.5a1.5 1.5 0 0 0 1.5-1.5V16.5a.75.75 0 0 1 1.5 0v2.25a3 3 0 0 1-3 3H5.25a3 3 0 0 1-3-3V16.5a.75.75 0 0 1 .75-.75Z"/></svg></button>
                <button class="icon-btn" id="restoreBtn" title="Restore Snippets"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"/></svg></button>
            </div>
        </div>
        <ul class="language-list" id="languageList">
            <!-- Languages populated here -->
        </ul>
        
        <div class="sidebar-header">Snippets</div>
        <div class="snippet-list-container">
            <div class="search-box">
                <input type="text" class="search-input" id="searchInput" placeholder="Search snippets...">
            </div>
            <ul class="snippet-list" id="snippetList">
                <!-- Snippets will be populated here -->
            </ul>
        </div>
    </div>

    <div class="main-content">
        <div id="welcomeState" class="empty-state">
            Select a snippet to edit or create a new one.
        </div>

        <div id="editorState" class="hidden">
            <div class="toolbar">
                <button id="newBtn" class="secondary">New Snippet</button>
                <button id="saveBtn">Save Snippet</button>
                <button id="deleteBtn" class="danger">Delete</button>
            </div>

            <div class="editor-form">
                <div class="form-group">
                    <label for="snippetName">Name</label>
                    <input type="text" id="snippetName" placeholder="e.g., Custom Post Type">
                </div>

                <div class="form-group">
                    <label for="snippetPrefix">Prefix (Trigger)</label>
                    <input type="text" id="snippetPrefix" placeholder="e.g., post_type">
                </div>

                <div class="form-group">
                    <label for="snippetDescription">Description</label>
                    <input type="text" id="snippetDescription" placeholder="Short description of what it does">
                </div>

                <div class="form-group">
                    <label for="snippetBody">Body</label>
                    <textarea id="snippetBody" placeholder="Code goes here... Use \${1}, \${2} for tabstops"></textarea>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allSnippets = {};
        let currentLang = 'php';
        let currentSnippet = null;

        // Elements
        const languageList = document.getElementById('languageList');
        const snippetList = document.getElementById('snippetList');
        const searchInput = document.getElementById('searchInput');
        const welcomeState = document.getElementById('welcomeState');
        const editorState = document.getElementById('editorState');
        
        // Form Elements
        const nameInput = document.getElementById('snippetName');
        const prefixInput = document.getElementById('snippetPrefix');
        const descInput = document.getElementById('snippetDescription');
        const bodyInput = document.getElementById('snippetBody');

        // Buttons
        const newBtn = document.getElementById('newBtn');
        const saveBtn = document.getElementById('saveBtn');
        const deleteBtn = document.getElementById('deleteBtn');
        const backupBtn = document.getElementById('backupBtn');
        const restoreBtn = document.getElementById('restoreBtn');
        const addLangBtn = document.getElementById('addLangBtn');

        // Initialize
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'loadSnippets':
                    allSnippets = message.data;
                    renderLanguageList();
                    renderSnippetList();
                    
                    // Check if current snippet still exists (it might have been deleted)
                    if (currentSnippet && currentLang) {
                        const langSnippets = allSnippets[currentLang] || {};
                        if (!langSnippets[currentSnippet]) {
                            currentSnippet = null;
                            showWelcome();
                        }
                    }
                    break;
            }
        });

        // Request snippets on load
        vscode.postMessage({ command: 'getSnippets' });

        // Language Selection
        languageList.addEventListener('click', (e) => {
            // Handle Add Snippet Button
            if (e.target.classList.contains('add-snippet-btn')) {
                e.stopPropagation();
                const item = e.target.closest('.language-item');
                const lang = item.dataset.lang;
                
                // Select language first
                selectLanguage(lang);
                
                // Open new snippet form
                currentSnippet = null;
                clearForm();
                showEditor();
                nameInput.focus();
                return;
            }

            const item = e.target.closest('.language-item');
            if (!item) return;

            selectLanguage(item.dataset.lang);
        });

        function selectLanguage(lang) {
            document.querySelectorAll('.language-item').forEach(el => el.classList.remove('active'));
            const item = languageList.querySelector(\`.language-item[data-lang="\${lang}"]\`);
            if (item) item.classList.add('active');
            
            currentLang = lang;
            currentSnippet = null;
            renderSnippetList();
            showWelcome();
        }

        // Snippet Selection
        snippetList.addEventListener('click', (e) => {
            const item = e.target.closest('.snippet-item');
            if (!item) return;

            selectSnippet(item.dataset.name);
        });

        // Search
        searchInput.addEventListener('input', () => {
            renderSnippetList();
        });

        // Actions
        newBtn.addEventListener('click', () => {
            currentSnippet = null;
            clearForm();
            showEditor();
            nameInput.focus();
        });

        saveBtn.addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (!name) {
                return; // Add validation UI later
            }

            const data = {
                language: currentLang,
                originalName: currentSnippet,
                newName: name,
                prefix: prefixInput.value,
                description: descInput.value,
                body: bodyInput.value
            };

            vscode.postMessage({
                command: 'saveSnippet',
                data: data
            });

            // Optimistic update
            currentSnippet = name;
        });

        deleteBtn.addEventListener('click', () => {
            if (!currentSnippet) return;

            // Send delete request to extension (it will handle confirmation)
            vscode.postMessage({
                command: 'deleteSnippet',
                data: {
                    language: currentLang,
                    name: currentSnippet
                }
            });
        });

        backupBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'backupSnippets' });
        });

        restoreBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'restoreSnippets' });
        });

        addLangBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'addLanguage' });
        });

        function renderLanguageList() {
            languageList.innerHTML = '';
            let languages = Object.keys(allSnippets).sort();
            
            // Ensure 'global' is at the top
            if (languages.includes('global')) {
                languages = ['global', ...languages.filter(l => l !== 'global')];
            } else {
                // If global doesn't exist yet (no file), we can optionally add it or wait for user to create it.
                // Better to show it so user can add snippets to it.
                if (!allSnippets['global']) {
                    allSnippets['global'] = {};
                    languages = ['global', ...languages];
                }
            }
            
            languages.forEach(lang => {
                const li = document.createElement('li');
                li.className = 'language-item';
                if (lang === currentLang) li.classList.add('active');
                li.dataset.lang = lang;
                
                li.innerHTML = \`
                    <span>\${lang.toUpperCase()}</span>
                    <button class="add-snippet-btn" title="Add Snippet to \${lang}">+</button>
                \`;
                
                languageList.appendChild(li);
            });
        }

        function renderSnippetList() {
            snippetList.innerHTML = '';
            const snippets = allSnippets[currentLang] || {};
            const searchTerm = searchInput.value.toLowerCase();

            // Sort snippets alphabetically by name
            const sortedEntries = Object.entries(snippets).sort((a, b) => a[0].localeCompare(b[0]));

            sortedEntries.forEach(([name, data]) => {
                if (searchTerm && !name.toLowerCase().includes(searchTerm) && !data.prefix.toLowerCase().includes(searchTerm)) {
                    return;
                }

                const li = document.createElement('li');
                li.className = 'snippet-item';
                if (name === currentSnippet) li.classList.add('active');
                li.dataset.name = name;
                
                li.innerHTML = \`
                    <div class="snippet-info">
                        <span class="snippet-name">\${name}</span>
                        <span class="snippet-prefix">\${data.prefix}</span>
                    </div>
                \`;
                
                snippetList.appendChild(li);
            });
        }

        function selectSnippet(name) {
            currentSnippet = name;
            const data = allSnippets[currentLang][name];
            
            document.querySelectorAll('.snippet-item').forEach(el => el.classList.remove('active'));
            const item = snippetList.querySelector(\`.snippet-item[data-name="\${name}"]\`);
            if (item) item.classList.add('active');

            nameInput.value = name;
            prefixInput.value = data.prefix;
            descInput.value = data.description || '';
            
            if (Array.isArray(data.body)) {
                bodyInput.value = data.body.join('\\n');
            } else {
                bodyInput.value = data.body;
            }

            showEditor();
        }

        function clearForm() {
            nameInput.value = '';
            prefixInput.value = '';
            descInput.value = '';
            bodyInput.value = '';
            
            document.querySelectorAll('.snippet-item').forEach(el => el.classList.remove('active'));
        }

        function showEditor() {
            welcomeState.classList.add('hidden');
            editorState.classList.remove('hidden');
        }

        function showWelcome() {
            welcomeState.classList.remove('hidden');
            editorState.classList.add('hidden');
        }
    </script>
</body>
</html>`;
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
