const uploadInput = document.getElementById('video-upload');
const startBtn = document.getElementById('start-btn');
const bitrateInput = document.getElementById('bitrate-input');
const framerateInput = document.getElementById('framerate-input');
const sourceVideo = document.getElementById('source-video');
const seekBar = document.getElementById('seek-bar');
const timeDisplay = document.getElementById('time-display');

const h264Canvas = document.getElementById('h264-canvas');
const h264Ctx = h264Canvas.getContext('2d');
const h264Stats = document.getElementById('h264-stats');

const vevcCanvas = document.getElementById('vevc-canvas');
const vevcCtx = vevcCanvas.getContext('2d');
const vevcStats = document.getElementById('vevc-stats');

let h264Encoder = null;
let h264Decoder = null;
let h264TotalBits = 0;

let vevcTotalBits = 0;
let pendingFrames = 0; // In-flight frames for VEVC Worker

// Playback Buffers & Sync
let h264FrameQueue = [];
let vevcFrameQueue = [];
let isBuffering = true;
let presentationTimer = null;
const BUFFER_TARGET = 5; // Start playback quickly to drain queue
const BUFFER_MAX = 65; // Must be > 60 (GOP size) to prevent pipeline deadlock!
let sourcePausedByBackpressure = false;
const bufferingIndicator = document.getElementById('buffering-indicator');

// Worker setup
const vevcWorker = new Worker('worker.js?v=5', { type: 'module' });
vevcWorker.onmessage = (e) => {
    const { type, payload } = e.data;
    if (type === 'vevc-ready') {
        if (uploadInput.files.length) {
            startBtn.disabled = false;
        }
    } else if (type === 'vevc-chunk') {
        vevcTotalBits += payload.byteLength * 8;
        vevcStats.textContent = `Bits: ${vevcTotalBits.toLocaleString()}`;
    } else if (type === 'vevc-frame') {
        const { width, height, data } = payload;
        // DO NOT allocate ImageData here to prevent 400MB Chrome VRAM spikes
        // V8 can easily hold 60 raw ArrayBuffers, but Canvas ImageData cannot
        vevcFrameQueue.push({ width, height, data });
        if (vevcCanvas.width !== width || vevcCanvas.height !== height) {
            vevcCanvas.width = width;
            vevcCanvas.height = height;
        }
        pendingFrames--;
    } else if (type === 'vevc-error') {
        console.error("VEVC Error:", payload);
    }
};

uploadInput.addEventListener('change', () => {
    if (uploadInput.files.length) {
        const url = URL.createObjectURL(uploadInput.files[0]);
        sourceVideo.src = url;
        // Check if WASM is ready before enabling (assume ready if worker sent it earlier)
        startBtn.disabled = false;
    }
});

startBtn.addEventListener('click', () => {
    startBtn.disabled = true;
    startComparison();
});

let activePipeline = false;
let seekTargetTime = -1;

function getH264BaselineCodec(width, height) {
    // 1マクロブロックは16x16ピクセル
    const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
    let levelHex = "1E"; // 3.0 (default for small videos)
    
    if (mbs <= 1620) {
        levelHex = "1E"; // Level 3.0
    } else if (mbs <= 3600) {
        levelHex = "1F"; // Level 3.1
    } else if (mbs <= 8192) {
        levelHex = "28"; // Level 4.0
    } else if (mbs <= 8704) {
        levelHex = "2A"; // Level 4.2
    } else if (mbs <= 22080) {
        levelHex = "32"; // Level 5.0
    } else {
        levelHex = "34"; // Level 5.2
    }
    
    // Baseline profile (42), constraint flags (E0) guarantees no B-frames and CAVLC (no CABAC)
    return `avc1.42E0${levelHex}`;
}

function initH264Pipeline(width, height, bitrate, framerate) {
    if (h264Canvas.width !== width || h264Canvas.height !== height) {
        h264Canvas.width = width;
        h264Canvas.height = height;
    }
    
    // Close existing if available
    try { h264Encoder?.close(); } catch(e){}
    try { h264Decoder?.close(); } catch(e){}
    
    const codec = getH264BaselineCodec(width, height);
    
    // Create H264 Decoder
    h264Decoder = new VideoDecoder({
        output: (frame) => {
            // Queue for rendering rather than immediate drawing
            h264FrameQueue.push(frame); 
        },
        error: (e) => console.error("H264 Decoder Error:", e)
    });
    
    h264Decoder.configure({ codec: codec });

    // Create H264 Encoder
    h264Encoder = new VideoEncoder({
        output: (chunk, metadata) => {
            h264TotalBits += chunk.byteLength * 8;
            h264Stats.textContent = `Bits: ${h264TotalBits.toLocaleString()}`;
            
            if (metadata.decoderConfig) {
                h264Decoder.configure(metadata.decoderConfig);
            }
            // Send chunk directly to the decoder
            h264Decoder.decode(chunk);
        },
        error: (e) => console.error("H264 Encoder Error:", e)
    });

    h264Encoder.configure({
        codec: codec,
        width: width,
        height: height,
        bitrate: bitrate,
        framerate: framerate,
        latencyMode: "realtime" // prioritize speed without queuing too many frames
    });
}

function startComparison() {
    activePipeline = true;
    h264TotalBits = 0;
    vevcTotalBits = 0;
    sourceVideo.currentTime = 0;
    
    // Initialize comparison pipelines when video metadata is loaded
    if (sourceVideo.readyState >= 1) {
        setupPipelinesAndPlay(0);
    } else {
        sourceVideo.onloadedmetadata = () => setupPipelinesAndPlay(0);
    }
}

let currentPresentationTime = 0;

function updateTimeDisplay(timeSec) {
    const cur = timeSec.toFixed(2);
    const dur = (sourceVideo.duration || 0).toFixed(2);
    timeDisplay.textContent = `${cur} / ${dur}`;
    if (sourceVideo.duration > 0) {
        seekBar.value = (timeSec / sourceVideo.duration) * 100;
    }
}

// timeupdate is no longer reliable because sourceVideo is manipulated out-of-sync
// sourceVideo.addEventListener('timeupdate', ... ) is removed

seekBar.addEventListener('input', (e) => {
    const percent = parseFloat(e.target.value);
    const targetTime = (percent / 100) * (sourceVideo.duration || 0);
    seekTargetTime = targetTime;
});

seekBar.addEventListener('change', (e) => {
    if (seekTargetTime >= 0) {
        const target = seekTargetTime;
        seekTargetTime = -1;
        if (activePipeline) {
            setupPipelinesAndPlay(target);
        }
    }
});

function setupPipelinesAndPlay(startTime = 0) {
    pendingFrames = 0;
    sourcePausedByBackpressure = false;
    
    // Clear existing presentation loop and queues
    if (presentationTimer) clearInterval(presentationTimer);
    h264FrameQueue.forEach(f => { try { f.close(); } catch(e){} });
    h264FrameQueue = [];
    vevcFrameQueue = [];
    isBuffering = true;
    bufferingIndicator.style.display = 'block';
    
    const width = sourceVideo.videoWidth;
    const height = sourceVideo.videoHeight;
    const bitrate = parseInt(bitrateInput.value, 10) * 1000;
    const framerate = parseInt(framerateInput.value, 10);
    
    initH264Pipeline(width, height, bitrate, framerate);
    
    // initialize VEVC via Worker (will overwrite previous IDs internally but effectively restart stream)
    vevcWorker.postMessage({
        type: 'init-vevc',
        payload: { width, height, bitrate, framerate }
    });
    
    // Ensure video is paused so we can manually seek it for ultra-fast async extraction
    sourceVideo.pause();
    
    // Use an offscreen canvas to get pixel data for VEVC
    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = width;
    offscreenCanvas.height = height;
    const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    
    const interval = 1 / framerate;
    currentPresentationTime = startTime;
    updateTimeDisplay(currentPresentationTime);
    
    // 1. Data Producer Loop (Runs as fast as possible, buffers up to MAX)
    async function extractFramesLoop() {
        let t = startTime;
        const dur = sourceVideo.duration || 10;
        
        while (t <= dur && activePipeline && seekTargetTime === -1) {
            // Fast backpressure: if buffers are full, yield aggressively to let worker and renderer catch up
            while ((pendingFrames >= 60 || h264FrameQueue.length > BUFFER_MAX || vevcFrameQueue.length > BUFFER_MAX || (h264Encoder && h264Encoder.encodeQueueSize > 15)) && activePipeline && seekTargetTime === -1) {
                await new Promise(r => setTimeout(r, 20));
            }
            if (!activePipeline || seekTargetTime !== -1) break;
            
            // Advance virtual time and wait for video to decode that frame
            sourceVideo.currentTime = t;
            await new Promise(r => {
                sourceVideo.addEventListener('seeked', r, { once: true });
            });
            if (!activePipeline || seekTargetTime !== -1) break;
            
            pendingFrames++;
            try {
                // Must ensure correct dimensions are picked up if video metadata isn't ready
                if (sourceVideo.videoWidth === 0) throw new Error("Video not ready");
                
                const frame = new VideoFrame(sourceVideo, { timestamp: t * 1e6 });
                if (h264Encoder.state === "configured") {
                     h264Encoder.encode(frame);
                }
                frame.close();
                
                ctx.drawImage(sourceVideo, 0, 0, width, height);
                const imgData = ctx.getImageData(0, 0, width, height);
                
                vevcWorker.postMessage({
                    type: 'encode-frame',
                    payload: { data: imgData.data }
                }, [imgData.data.buffer]);
                
                // Prevent Wasm OOM by pacing message dispatch for high-res frames
                if (width * height > 500_000) {
                    await new Promise(r => setTimeout(r, 5));
                }
                
            } catch (err) {
                console.error("Frame extraction error", err);
                pendingFrames--;
            }
            t += interval;
        }
    }
    
    extractFramesLoop();
    
    // Start presentation loop at playback framerate
    const renderInterval = 1000 / framerate;
    presentationTimer = setInterval(() => {
        if (!activePipeline || seekTargetTime !== -1) return;
        
        if (isBuffering) {
            if (h264FrameQueue.length >= BUFFER_TARGET && vevcFrameQueue.length >= BUFFER_TARGET) {
                isBuffering = false;
                bufferingIndicator.style.display = 'none';
            } else {
                return; // Keep buffering
            }
        }
        
        // Playing
        if (!isBuffering) {
            if (h264FrameQueue.length > 0 && vevcFrameQueue.length > 0) {
                const h264Frame = h264FrameQueue.shift();
                const vevcPayload = vevcFrameQueue.shift();
                
                h264Ctx.drawImage(h264Frame, 0, 0, width, height);
                h264Frame.close();
                
                // Construct the heavy ImageData exactly at draw-time to bound VRAM!
                const vevcImgData = new ImageData(new Uint8ClampedArray(vevcPayload.data), vevcPayload.width, vevcPayload.height);
                vevcCtx.putImageData(vevcImgData, 0, 0);
                
                currentPresentationTime += interval;
                updateTimeDisplay(currentPresentationTime);
            } else {
                // Buffer Underrun!
                isBuffering = true;
                bufferingIndicator.style.display = 'block';
                
                // Keep playing if ended but we're out of frames
                // Check if the extractor loop finished (i.e. we reached video duration)
                if (currentPresentationTime >= (sourceVideo.duration || 10) - interval * 2) {
                    bufferingIndicator.style.display = 'none';
                    clearInterval(presentationTimer);
                }
            }
        }
    }, renderInterval);
}
