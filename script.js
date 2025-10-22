class P2PBrowserTest {
    constructor() {
        this.ws = null;
        this.wsUrl = 'wss://p2p-server-jgqj.onrender.com/ws';
        this.keyPair = null;
        this.sharedKey = null;
        this.isEncryptionReady = false;
        this.selectedFiles = [];
        this.receivedFiles = [];
        this.init();
    }

    init() {
        this.bindEvents();
        this.log('🚀 P2P Browser Test initialized');
        this.log(`🌐 Using server: ${this.wsUrl}`);
    }

    bindEvents() {
        document.getElementById('create-btn').onclick = () => this.createSession();
        document.getElementById('join-btn').onclick = () => this.showJoinInput();
        document.getElementById('connect-btn').onclick = () => this.joinSession();
        document.getElementById('cancel-btn').onclick = () => this.hideJoinInput();
        document.getElementById('copy-btn').onclick = () => this.copyToken();
        document.getElementById('file-input-zone').onclick = () => {
            document.getElementById('file-input').click();
        };
        document.getElementById('file-input').onchange = (e) => {
            this.handleFileSelect(Array.from(e.target.files));
        };
        document.getElementById('send-btn').onclick = () => this.sendFiles();

        const zone = document.getElementById('file-input-zone');
        zone.ondragover = (e) => { e.preventDefault(); zone.style.background = '#f0f0ff'; };
        zone.ondragleave = () => { zone.style.background = ''; };
        zone.ondrop = (e) => {
            e.preventDefault();
            zone.style.background = '';
            this.handleFileSelect(Array.from(e.dataTransfer.files));
        };
    }

    async createSession() {
        try {
            this.log('🎯 Creating session...');
            await this.connectWebSocket();
            this.sendMessage({
                type: 'CREATE_INVITATION',
                expires_in_minutes: 30,
                intent: 'send_files',
                capabilities: ['file_send', 'encryption']
            });
        } catch (error) {
            this.log('❌ Failed to create session: ' + error.message);
        }
    }

    async joinSession() {
        const token = document.getElementById('token-input').value.trim();
        if (!token) {
            alert('Please enter a session token');
            return;
        }
        try {
            this.log('🎯 Joining session...');
            await this.connectWebSocket();
            this.sendMessage({
                type: 'JOIN_BY_TOKEN',
                token: token,
                intent: 'receive_files',
                capabilities: ['file_receive', 'encryption']
            });
        } catch (error) {
            this.log('❌ Failed to join session: ' + error.message);
        }
    }

    connectWebSocket() {
        return new Promise((resolve, reject) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                resolve();
                return;
            }
            this.updateStatus('Connecting...');
            this.ws = new WebSocket(this.wsUrl);

            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);

            this.ws.onopen = () => {
                clearTimeout(timeout);
                this.log('✅ Connected to P2P server');
                this.updateStatus('Connected');
                resolve();
            };

            this.ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                this.log(`📨 Received: ${message.type}`);
                this.handleMessage(message);
            };

            this.ws.onerror = (error) => {
                clearTimeout(timeout);
                this.log('❌ WebSocket error');
                this.updateStatus('Error');
                reject(error);
            };

            this.ws.onclose = () => {
                this.log('🔌 Disconnected');
                this.updateStatus('Disconnected');
            };
        });
    }

    sendMessage(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            this.log(`📤 Sent: ${message.type}`);
            return true;
        }
        return false;
    }

    async handleMessage(message) {
        switch (message.type) {
            case 'INVITATION_CREATED':
                this.log('🎫 Session created: ' + message.session_id);
                this.showToken(message.token);
                await this.setupEncryption();
                break;
            case 'JOINED_SESSION':
                this.log('✅ Joined session: ' + message.session_id);
                this.hideJoinInput();
                await this.setupEncryption();
                break;
            case 'KEY_EXCHANGE':
                this.log('🔑 Received peer public key');
                await this.handleKeyExchange(message);
                break;
            case 'ENCRYPTED_MESSAGE':
                this.log('📨 Received encrypted file');
                await this.handleEncryptedMessage(message);
                break;
            default:
                this.log('❓ Unknown message: ' + message.type);
        }
    }

    async setupEncryption() {
        try {
            this.log('🔐 Setting up encryption...');
            this.updateEncryptionStatus('🔄', 'Generating keys...');
            this.keyPair = await crypto.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-256' },
                true,
                ['deriveKey', 'deriveBits']
            );
            const publicKeyBuffer = await crypto.subtle.exportKey('raw', this.keyPair.publicKey);
            const publicKeyBytes = new Uint8Array(publicKeyBuffer);
            this.sendMessage({
                type: 'KEY_EXCHANGE',
                public_key: Array.from(publicKeyBytes),
                party: 'web',
                algorithm: 'ECDH-P256'
            });
            this.updateEncryptionStatus('🔑', 'Exchanging keys...');
            setTimeout(() => {
                if (!this.isEncryptionReady) {
                    this.onEncryptionReady();
                }
            }, 3000);
        } catch (error) {
            this.log('❌ Encryption setup failed: ' + error.message);
            this.updateEncryptionStatus('⚠️', 'Encryption error');
        }
    }

    async importAesKeyFromBase64(aesKeyBase64) {
        const binary = atob(aesKeyBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return await crypto.subtle.importKey(
            "raw",
            bytes.buffer,
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
        );
    }

    async handleKeyExchange(message) {
        try {
            // Python backend may send AES key directly
            if (message.key) {
                this.sharedKey = await this.importAesKeyFromBase64(message.key);
                this.onEncryptionReady();
                return;
            }
            // Otherwise: normal browser ECDH
            const peerKeyArray = new Uint8Array(message.public_key);
            const peerPublicKey = await crypto.subtle.importKey(
                'raw', peerKeyArray,
                { name: 'ECDH', namedCurve: 'P-256' },
                false, []
            );
            this.sharedKey = await crypto.subtle.deriveKey(
                { name: 'ECDH', public: peerPublicKey },
                this.keyPair.privateKey,
                { name: 'AES-GCM', length: 256 },
                false, ['encrypt', 'decrypt']
            );
            this.onEncryptionReady();
        } catch (error) {
            this.log('❌ Key exchange failed: ' + error.message);
        }
    }

    onEncryptionReady() {
        this.isEncryptionReady = true;
        this.log('✅ Encryption ready!');
        this.updateEncryptionStatus('🔒', 'End-to-end encrypted');
        document.getElementById('send-btn').disabled = false;
    }

    handleFileSelect(files) {
        this.selectedFiles = files;
        this.log(`📁 Selected ${files.length} file(s)`);
        this.updateFileList();
    }

    updateFileList() {
        const container = document.getElementById('selected-files');
        if (this.selectedFiles.length > 0) {
            container.classList.remove('hidden');
            container.innerHTML = this.selectedFiles.map((file, index) => `
                <div class="file-item">
                    <div>
                        <strong>${file.name}</strong><br>
                        <small>${this.formatFileSize(file.size)}</small>
                    </div>
                    <button onclick="app.removeFile(${index})" style="background: none; border: none; color: #ef4444; cursor: pointer; padding: 4px 8px; border-radius: 4px;">❌</button>
                </div>
            `).join('');
        } else {
            container.classList.add('hidden');
        }
    }

    removeFile(index) {
        this.selectedFiles.splice(index, 1);
        this.updateFileList();
    }

    async sendFiles() {
        if (!this.isEncryptionReady) {
            alert('Encryption not ready. Please wait...');
            return;
        }
        if (this.selectedFiles.length === 0) {
            alert('No files selected.');
            return;
        }
        this.log(`📤 Sending ${this.selectedFiles.length} file(s)...`);
        document.getElementById('progress-section').classList.remove('hidden');
        document.getElementById('send-btn').disabled = true;

        try {
            for (let i = 0; i < this.selectedFiles.length; i++) {
                const file = this.selectedFiles[i];
                const arrayBuffer = await file.arrayBuffer();
                const fileData = new Uint8Array(arrayBuffer);
                const payload = {
                    filename: file.name,
                    data: Array.from(fileData),
                    size: file.size,
                    type: 'FILE_DATA'
                };
                const encrypted = await this.encryptData(payload);
                this.sendMessage({
                    type: 'ENCRYPTED_MESSAGE',
                    encrypted_payload: encrypted,
                    message_type: 'FILE_DATA',
                    encryption_algorithm: 'AES-256-GCM'
                });
                const progress = ((i + 1) / this.selectedFiles.length) * 100;
                this.updateProgress(progress);
                this.log(`✅ Sent: ${file.name}`);
            }
            this.log('🎉 All files sent successfully!');
        } catch (error) {
            this.log('❌ Send failed: ' + error.message);
        } finally {
            document.getElementById('send-btn').disabled = false;
            setTimeout(() => {
                document.getElementById('progress-section').classList.add('hidden');
                this.updateProgress(0);
            }, 2000);
        }
    }

    async handleEncryptedMessage(message) {
        try {
            const decrypted = await this.decryptData(message.encrypted_payload);
            if (decrypted.type === 'FILE_DATA') {
                this.log(`📁 Received: ${decrypted.filename}`);
                const blob = new Blob([new Uint8Array(decrypted.data)]);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = decrypted.filename;
                a.click();
                URL.revokeObjectURL(url);
                this.receivedFiles.push({
                    name: decrypted.filename,
                    size: decrypted.size,
                    time: new Date().toLocaleTimeString()
                });
                this.updateReceivedList();
                this.log(`✅ Downloaded: ${decrypted.filename}`);
            }
        } catch (error) {
            this.log('❌ Decrypt failed: ' + error.message);
        }
    }

    async encryptData(data) {
        const encoder = new TextEncoder();
        const dataBytes = encoder.encode(JSON.stringify(data));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            this.sharedKey,
            dataBytes
        );
        return {
            iv: Array.from(iv),
            data: Array.from(new Uint8Array(encrypted))
        };
    }

    async decryptData(encryptedData) {
        if (typeof encryptedData.iv === "string" && typeof encryptedData.ciphertext === "string") {
            const iv = Uint8Array.from(atob(encryptedData.iv), c => c.charCodeAt(0));
            const ciphertext = Uint8Array.from(atob(encryptedData.ciphertext), c => c.charCodeAt(0));
            if (encryptedData.key) {
                this.sharedKey = await this.importAesKeyFromBase64(encryptedData.key);
            }
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                this.sharedKey,
                ciphertext
            );
            const decoder = new TextDecoder();
            return JSON.parse(decoder.decode(decrypted));
        } else {
            const iv = new Uint8Array(encryptedData.iv);
            const ciphertext = new Uint8Array(encryptedData.data);
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                this.sharedKey,
                ciphertext
            );
            const decoder = new TextDecoder();
            return JSON.parse(decoder.decode(decrypted));
        }
    }

    updateReceivedList() {
        const container = document.getElementById('received-files');
        if (this.receivedFiles.length > 0) {
            container.innerHTML = this.receivedFiles.map(file => `
                <div class="file-item">
                    <div>
                        <strong>${file.name}</strong><br>
                        <small>${this.formatFileSize(file.size)} - ${file.time}</small>
                    </div>
                    <span style="color: #10b981;">✅</span>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<div style="padding: 20px; text-align: center; color: #6b7280;">No files received yet</div>';
        }
    }

    updateStatus(status) {
        const indicator = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');
        text.textContent = status;
        if (status === 'Connected') {
            indicator.classList.add('connected');
        } else {
            indicator.classList.remove('connected');
        }
    }

    updateEncryptionStatus(icon, text) {
        document.getElementById('encryption-icon').textContent = icon;
        document.getElementById('encryption-text').textContent = text;
    }

    showToken(token) {
        document.getElementById('token-section').classList.remove('hidden');
        document.getElementById('token-display').textContent = token;
    }

    showJoinInput() {
        document.getElementById('join-section').classList.remove('hidden');
        document.getElementById('token-input').focus();
    }

    hideJoinInput() {
        document.getElementById('join-section').classList.add('hidden');
        document.getElementById('token-input').value = '';
    }

    copyToken() {
        const token = document.getElementById('token-display').textContent;
        navigator.clipboard.writeText(token).then(() => {
            const btn = document.getElementById('copy-btn');
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy Token', 2000);
        });
    }

    updateProgress(percent) {
        document.getElementById('progress-fill').style.width = percent + '%';
        document.getElementById('progress-text').textContent = Math.round(percent) + '%';
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    log(message) {
        const log = document.getElementById('log');
        const time = new Date().toLocaleTimeString();
        log.innerHTML += `<div>[${time}] ${message}</div>`;
        log.scrollTop = log.scrollHeight;
    }
}

let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new P2PBrowserTest();
});
