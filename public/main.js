// Importa las funciones que necesitas de los SDKs
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc } from "firebase/firestore";

// Tu configuración de Firebase (DEBE ser mantenida)
const firebaseConfig = {
  apiKey: "AIzaSyDWFe7eileuJfEa7OCKkabDolN3O6t7-tM",
  authDomain: "eastern-rain-385517.firebaseapp.com",
  projectId: "eastern-rain-385517",
  storageBucket: "eastern-rain-385517.firebasestorage.app",
  messagingSenderId: "699890478814",
  appId: "1:699890478814:web:148ce48d0b950658061c4f"
};

// Inicializa Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
console.log("Firebase y Firestore inicializados correctamente!");

// --- Configuración de la Cloud Function ---
const CLOUD_FUNCTION_URL = "https://southamerica-east1-eastern-rain-385517.cloudfunctions.net/detectLicensePlate";

// --- Elementos del DOM ---
const elements = {
    useCameraBtn: document.getElementById('use-camera-btn'),
    uploadBtn: document.getElementById('upload-btn'),
    videoContainer: document.getElementById('video-container'),
    cameraFeed: document.getElementById('camera-feed'),
    cameraOff: document.getElementById('camera-off'),
    toggleCameraBtn: document.getElementById('toggle-camera-btn'),
    captureBtn: document.getElementById('capture-btn'),
    imageInput: document.getElementById('image-input'),
    imagePreview: document.getElementById('image-preview'),
    analyzeBtn: document.getElementById('analyze-btn'),
    loader: document.getElementById('loader'),
    results: document.getElementById('results'),
    detectionResults: document.getElementById('detection-results'),
    newScanBtn: document.getElementById('new-scan-btn'),
    canvas: document.getElementById('canvas'),
    context: null,
    // Config panel elements
    configPanel: document.getElementById('config-panel'),
    autoModeCheckbox: document.getElementById('auto-mode'),
    quickModeCheckbox: document.getElementById('quick-mode'),
    vibrateModeCheckbox: document.getElementById('vibrate-mode'),
    batchModeCheckbox: document.getElementById('batch-mode'),
};

if (elements.canvas) {
    elements.context = elements.canvas.getContext('2d');
}

// --- Estado mejorado ---
let state = {
    currentImage: null,
    detectionResult: null,
    isProcessing: false,
    userInteracted: false,
    countdownTimer: null,
    autoConfirmTimer: null,
    currentStream: null,
    sessionId: Date.now().toString(36) + Math.random().toString(36).substr(2),
    stats: {
        totalScans: 0,
        autoRegistered: 0,
        quickConfirmed: 0,
        manualEntries: 0
    },
    batchMode: {
        enabled: false,
        currentIndex: 0,
        plates: [],
        startTime: null
    },
    config: {
        autoMode: true,
        quickMode: true,
        vibrateMode: false,
        batchMode: false
    }
};

// --- Flujo Principal de Procesamiento ---

async function processNewImage(imageDataUrl) {
    state.currentImage = imageDataUrl;
    elements.imagePreview.src = imageDataUrl;
    elements.imagePreview.style.display = 'block';
    elements.videoContainer.style.display = 'none';
    elements.cameraOff.style.display = 'none';
    elements.results.style.display = 'none';
    
    await processImageIntelligently();
}

// --- Procesamiento inteligente ---
async function processImageIntelligently() {
    if (!state.currentImage) return;
    
    state.isProcessing = true;
    updateUIForProcessing();
    
    try {
        const response = await fetch(CLOUD_FUNCTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: state.currentImage })
        });
        
        if (!response.ok) {
            throw new Error(`La API devolvió un error: ${response.statusText}`);
        }

        const result = await response.json();
        state.detectionResult = result;
        state.stats.totalScans++;
        state.userInteracted = false; // Reset interaction flag for new image
        
        // Tomar acción basada en el nivel de automatización
        // Respetar configuración del usuario
        if (state.config.autoMode && result.suggestedAction === 'auto_register') {
            await handleAutoRegister(result);
        } else if (state.config.quickMode && result.suggestedAction === 'quick_confirm') {
            await handleQuickConfirm(result);
        } else if (result.suggestedAction === 'manual_select') {
            await handleManualSelection(result);
        } else {
            await handleManualInput(result);
        }
        
        logAutomationDecision(result);
        
    } catch (error) {
        console.error('Error:', error);
        handleError(error);
    } finally {
        state.isProcessing = false;
        updateUIAfterProcessing();
    }
}

// --- Manejadores de acciones ---
async function handleAutoRegister(result) {
    const plate = result.plates[0].plate;
    console.log(`🤖 Registro automático: ${plate} (confianza: ${Math.round(result.confidence*100)}%)`);
    
    await registerInspection(plate);
    state.stats.autoRegistered++;
    
    showAutoConfirmation(plate, result.confidence);
    
    if (state.config.batchMode && state.batchMode.enabled) {
        updateBatchCounter();
        setTimeout(resetForNextBatchScan, 1500);
    } else {
        setTimeout(resetForNextScan, 1500);
    }
}

async function handleQuickConfirm(result) {
    const plate = result.plates[0].plate;
    console.log(`⚡ Confirmación rápida necesaria: ${plate}`);
    
    showQuickConfirmUI(plate, result.plates, result.confidence);
    
    state.autoConfirmTimer = setTimeout(() => {
        if (!state.userInteracted) {
            console.log('⏱️ Auto-confirmación por timeout');
            confirmQuickPlate(plate);
        }
    }, 3000);
}

async function handleManualSelection(result) {
    console.log(`👤 Selección manual necesaria`);
    showManualSelectionUI(result.plates);
}

async function handleManualInput(result) {
    console.log(`⌨️ Entrada manual necesaria`);
    showManualInputUI(result.fullTextDetected);
}

// --- Lógica de UI ---

function updateUIForProcessing() {
    elements.loader.style.display = 'block';
    elements.results.style.display = 'block';
    elements.detectionResults.innerHTML = `<div style="text-align:center; padding: 20px;">Procesando...</div>`;
}

function updateUIAfterProcessing() {
    elements.loader.style.display = 'none';
}

function handleError(error) {
    elements.detectionResults.innerHTML = `
        <div style="text-align: center; padding: 20px; color: #ea4335;">
            <h3>Error</h3>
            <p>${error.message}</p>
            <button onclick="resetScanner()" class="btn">Reintentar</button>
        </div>
    `;
}

function showAutoConfirmation(plate, confidence) {
    elements.results.style.display = 'block';
    elements.detectionResults.innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <div style="font-size: 48px; color: #34a853; margin-bottom: 15px;">✅</div>
            <h3 style="color: #34a853;">Registrado automáticamente</h3>
            <div class="plate-number" style="font-size: 36px; margin: 15px 0;">${plate}</div>
            <div style="font-size: 14px; color: #666;">
                Confianza: ${Math.round(confidence*100)}%
            </div>
            <div style="font-size: 12px; color: #888; margin-top: 20px;">
                Listo para siguiente patente...
            </div>
        </div>
    `;
    
    if (state.config.vibrateMode && navigator.vibrate) navigator.vibrate(100);
    playConfirmationSound();
}

function showQuickConfirmUI(plate, allPlates, confidence) {
    elements.results.style.display = 'block';
    elements.detectionResults.innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <div style="font-size: 32px; color: #fbbc05; margin-bottom: 10px;">⚡</div>
            <h3 style="color: #fbbc05;">¿Es correcta esta patente?</h3>
            <div class="plate-number" style="font-size: 42px; margin: 20px 0; font-weight: bold;">${plate}</div>
            
            <div style="display: flex; justify-content: center; gap: 15px; margin: 25px 0;">
                <button onclick="confirmQuickPlate('${plate}')" 
                        style="padding: 15px 30px; background: #34a853; color: white; border: none; border-radius: 10px; font-size: 18px; cursor: pointer;">
                    ✅ Sí
                </button>
                <button onclick="showOtherOptions()" 
                        style="padding: 15px 30px; background: #ea4335; color: white; border: none; border-radius: 10px; font-size: 18px; cursor: pointer;">
                    ❌ No
                </button>
            </div>
            
            <div style="font-size: 12px; color: #666;">
                Se auto-confirmará en <span id="countdown">3</span> segundos
            </div>
            
            ${allPlates.length > 1 ? `
                <div style="margin-top: 20px; font-size: 12px; color: #666;">
                    Otras opciones: ${allPlates.slice(1).map(p => p.plate).join(', ')}
                </div>
            ` : ''}
        </div>
    `;
    
    startCountdown(3);
}

function showManualSelectionUI(plates) {
    elements.results.style.display = 'block';
    let optionsHTML = `
        <div style="padding: 20px;">
            <h3>👤 Selecciona la correcta</h3>
    `;

    plates.forEach(p => {
        optionsHTML += `
            <button onclick="confirmManualPlate('${p.plate}')" class="btn-block" style="margin-bottom: 10px;">
                ${p.plate} <span style="color: #ddd;">(${Math.round(p.confidence*100)}%)</span>
            </button>
        `;
    });

    optionsHTML += `
        <button onclick="showManualInputUI()" class="btn-block btn-secondary">Ninguna es correcta</button>
        </div>
    `;
    elements.detectionResults.innerHTML = optionsHTML;
}

function showManualInputUI(prefill = '') {
    elements.results.style.display = 'block';
    elements.detectionResults.innerHTML = `
        <div style="padding: 20px;">
            <h3>⌨️ Ingreso Manual</h3>
            <input type="text" id="manual-input-field" value="${prefill}" placeholder="AAA 123" style="width: 100%; font-size: 24px; text-align: center; margin-bottom: 15px;">
            <button onclick="confirmManualPlate(document.getElementById('manual-input-field').value)" class="btn btn-primary">Confirmar</button>
        </div>
    `;
}

// --- Funciones de Soporte de UI ---

function startCountdown(seconds) {
    clearTimeout(state.countdownTimer);
    let count = seconds;
    const countdownElement = document.getElementById('countdown');
    
    const update = () => {
        if (countdownElement) countdownElement.textContent = count;
    };
    update();

    state.countdownTimer = setInterval(() => {
        count--;
        update();
        if (count <= 0) {
            clearInterval(state.countdownTimer);
        }
    }, 1000);
}

function playConfirmationSound() {
    if (!state.config.vibrateMode) return; // Only play if vibration is enabled, assuming sound is tied to it for simplicity
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (!audioContext) return;
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.type = 'sine';
        oscillator.frequency.value = 800;
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.2);
    } catch (e) {
        console.log('Audio no disponible.');
    }
}

// --- Lógica de Confirmación y Registro ---

async function confirmQuickPlate(plate) {
    if (state.userInteracted) return;
    state.userInteracted = true;
    clearTimeout(state.autoConfirmTimer);
    clearInterval(state.countdownTimer);

    console.log(`✅ Confirmado rápido: ${plate}`);
    await registerInspection(plate);
    state.stats.quickConfirmed++;
    showAutoConfirmation(plate, state.detectionResult.confidence);

     if (state.config.batchMode && state.batchMode.enabled) {
        updateBatchCounter();
        setTimeout(resetForNextBatchScan, 1500);
    } else {
        setTimeout(resetForNextScan, 1500);
    }
}

async function confirmManualPlate(plate) {
    if (!plate || plate.trim().length < 5) {
        alert("Patente inválida.");
        return;
    }
    const cleanPlate = plate.trim().toUpperCase();

    console.log(`🧑‍💻 Confirmado manual: ${cleanPlate}`);
    await registerInspection(cleanPlate);
    state.stats.manualEntries++;
    showAutoConfirmation(cleanPlate, 0); // Confianza 0 para manual

    if (state.config.batchMode && state.batchMode.enabled) {
        updateBatchCounter();
        setTimeout(resetForNextBatchScan, 1500);
    } else {
        setTimeout(resetForNextScan, 1500);
    }
}

function showOtherOptions() {
    state.userInteracted = true;
    clearTimeout(state.autoConfirmTimer);
    clearInterval(state.countdownTimer);
    handleManualSelection(state.detectionResult);
}

// --- Integración con Sistema Principal (Firestore) ---

async function registerInspection(plate) {
    try {
        const inspectionData = {
            plate: plate,
            timestamp: new Date().toISOString(),
            sessionId: state.sessionId,
            confidence: state.detectionResult?.confidence || null,
            suggestedAction: state.detectionResult?.suggestedAction || 'manual',
        };
        await addDoc(collection(db, 'inspections'), inspectionData);
        console.log('📋 Inspección registrada:', plate);
    } catch (error) {
        console.error('Error registrando inspección:', error);
    }
}

function logAutomationDecision(result) {
    console.log("Decision Log:", {
        suggestion: result.suggestedAction,
        confidence: result.confidence,
        plate: result.plates.length > 0 ? result.plates[0].plate : 'N/A',
        allPlates: result.plates.map(p => p.plate)
    });
}

// --- Reset y Modos de Operación ---

function resetScanner() {
    state.currentImage = null;
    state.detectionResult = null;
    if (state.currentStream) {
        state.currentStream.getTracks().forEach(track => track.stop());
        state.currentStream = null;
    }
    elements.videoContainer.style.display = 'none';
    elements.cameraOff.style.display = 'block';
    elements.imagePreview.style.display = 'none';
    elements.results.style.display = 'none';
    elements.loader.style.display = 'none';
    elements.imageInput.value = '';
    state.sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    console.log("🔄 Scanner reseteado. Nueva sesión:", state.sessionId);
}

function resetForNextScan() {
    elements.imagePreview.style.display = 'none';
    elements.results.style.display = 'none';
    startCamera(); // Vuelve a la cámara
}

function resetForNextBatchScan() {
     elements.results.style.display = 'none';
     // En modo batch, la cámara permanece activa, solo se limpia el resultado
}

// --- Modo Batch ---
function enableBatchMode() {
    // Only enable if config allows
    if (!state.config.batchMode) {
        alert("Modo rápido no activado en configuración.");
        return;
    }

    state.batchMode.enabled = true;
    state.batchMode.plates = [];
    state.batchMode.startTime = Date.now();
    elements.results.style.display = 'block';
    elements.detectionResults.innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <div style="font-size: 32px; margin-bottom: 15px;">🚗</div>
            <h3>Modo Inspección Rápida</h3>
            <p>Apunta la cámara a las patentes</p>
            <div style="margin: 20px 0; font-size: 48px; font-weight: bold;" id="batch-counter">0</div>
            <button onclick="stopBatchMode()" class="btn btn-danger">⏹️ Detener</button>
        </div>
    `;
    startCamera();
}

function stopBatchMode() {
    state.batchMode.enabled = false;
    showStatistics();
}

function updateBatchCounter() {
    state.batchMode.plates.push(state.detectionResult.plates[0].plate);
    const counter = document.getElementById('batch-counter');
    if (counter) {
        counter.textContent = state.batchMode.plates.length;
    }
}


// --- Estadísticas ---
function showStatistics() {
    const stats = state.stats;
    const autoRate = stats.totalScans > 0 ? Math.round((stats.autoRegistered / stats.totalScans) * 100) : 0;
    
    elements.results.style.display = 'block';
    elements.detectionResults.innerHTML = `
        <div style="padding: 20px;">
            <h3>📊 Estadísticas de Sesión</h3>
            <div style="margin: 20px 0; font-size: 16px;">
                <div style="display: flex; justify-content: space-between; margin: 10px 0;"><span>Total:</span><span style="font-weight: bold;">${stats.totalScans}</span></div>
                <div style="display: flex; justify-content: space-between; margin: 10px 0; color: #34a853;"><span>Automáticos:</span><span style="font-weight: bold;">${stats.autoRegistered} (${autoRate}%)</span></div>
                <div style="display: flex; justify-content: space-between; margin: 10px 0; color: #fbbc05;"><span>Confirmados:</span><span style="font-weight: bold;">${stats.quickConfirmed}</span></div>
                <div style="display: flex; justify-content: space-between; margin: 10px 0; color: #ea4335;"><span>Manuales:</span><span style="font-weight: bold;">${stats.manualEntries}</span></div>
            </div>
            <button onclick="resetScanner()" class="btn btn-primary">🔄 Nueva Sesión</button>
        </div>
    `;
}

// --- Configuración rápida ---
function loadConfig() {
    const savedConfig = JSON.parse(localStorage.getItem('plateScannerConfig'));
    if (savedConfig) {
        state.config = { ...state.config, ...savedConfig };
    }
    // Update UI checkboxes
    if (elements.autoModeCheckbox) elements.autoModeCheckbox.checked = state.config.autoMode;
    if (elements.quickModeCheckbox) elements.quickModeCheckbox.checked = state.config.quickMode;
    if (elements.vibrateModeCheckbox) elements.vibrateModeCheckbox.checked = state.config.vibrateMode;
    if (elements.batchModeCheckbox) elements.batchModeCheckbox.checked = state.config.batchMode;
}

function saveConfig() {
    state.config.autoMode = elements.autoModeCheckbox.checked;
    state.config.quickMode = elements.quickModeCheckbox.checked;
    state.config.vibrateMode = elements.vibrateModeCheckbox.checked;
    state.config.batchMode = elements.batchModeCheckbox.checked;
    localStorage.setItem('plateScannerConfig', JSON.stringify(state.config));
    if (elements.configPanel) elements.configPanel.style.display = 'none';
    console.log('Configuración guardada:', state.config);
    
    // Apply changes directly (e.g., enable/disable batch mode if checked)
    if (state.config.batchMode && !state.batchMode.enabled) {
        enableBatchMode();
    } else if (!state.config.batchMode && state.batchMode.enabled) {
        stopBatchMode();
    }
}

function toggleConfigPanel() {
    if (elements.configPanel.style.display === 'none') {
        loadConfig(); // Load settings before showing
        elements.configPanel.style.display = 'block';
    } else {
        elements.configPanel.style.display = 'none';
    }
}


// --- Captura de Cámara y Archivos (Adaptado al nuevo flujo) ---

async function startCamera() {
    try {
        if (state.currentStream) {
            state.currentStream.getTracks().forEach(track => track.stop());
        }
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        state.currentStream = stream;
        elements.cameraFeed.srcObject = stream;
        elements.videoContainer.style.display = 'block';
        elements.cameraOff.style.display = 'none';
        elements.captureBtn.style.display = 'block';
        elements.imagePreview.style.display = 'none';
    } catch (error) {
        console.error('Error al acceder a la cámara:', error);
        alert('No se pudo acceder a la cámara.');
    }
}

function captureFromCamera() {
    if (!elements.context || !elements.cameraFeed.srcObject) return;
    
    elements.canvas.width = elements.cameraFeed.videoWidth;
    elements.canvas.height = elements.cameraFeed.videoHeight;
    elements.context.drawImage(elements.cameraFeed, 0, 0, elements.canvas.width, elements.canvas.height);
    
    // Procesa la imagen directamente
    processNewImage(elements.canvas.toDataURL('image/jpeg', 0.8));
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = e => processNewImage(e.target.result);
    reader.readAsDataURL(file);
}

// --- Inicialización ---
document.addEventListener('DOMContentLoaded', () => {
    // Configurar event listeners
    if (elements.useCameraBtn) elements.useCameraBtn.addEventListener('click', startCamera);
    if (elements.uploadBtn) elements.uploadBtn.addEventListener('click', () => elements.imageInput.click());
    if (elements.toggleCameraBtn) elements.toggleCameraBtn.addEventListener('click', startCamera); // Simplificado
    if (elements.captureBtn) elements.captureBtn.addEventListener('click', captureFromCamera);
    if (elements.imageInput) elements.imageInput.addEventListener('change', handleFileUpload);
    
    // Funciones globales para onclick
    window.confirmQuickPlate = confirmQuickPlate;
    window.showOtherOptions = showOtherOptions;
    window.confirmManualPlate = confirmManualPlate;
    window.showManualInputUI = showManualInputUI;
    window.resetScanner = resetScanner;
    window.enableBatchMode = enableBatchMode;
    window.stopBatchMode = stopBatchMode;
    window.showStatistics = showStatistics;
    window.toggleConfigPanel = toggleConfigPanel; // Make global
    window.saveConfig = saveConfig; // Make global

    console.log('✅ Sistema de lectura de patentes INTELIGENTE inicializado');
    
    // TEMP: Add buttons for new modes for testing
    const controls = document.getElementById('controls');
    if (controls) {
        controls.innerHTML += `
        <button onclick="enableBatchMode()" class="btn">Modo Rápido</button>
        <button onclick="showStatistics()" class="btn">Estadísticas</button>
        `;
    }

    loadConfig(); // Load config on startup
});