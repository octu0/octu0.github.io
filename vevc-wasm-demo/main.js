const uploadInput = document.getElementById('video-upload');
const startBtn = document.getElementById('start-btn');
const bitrateInput = document.getElementById('bitrate-input');
const framerateInput = document.getElementById('framerate-input');
const sourceVideo = document.getElementById('source-video');
const seekBar = document.getElementById('seek-bar');
const seekbarProgress = document.getElementById('seekbar-progress');
const timeCurrent = document.getElementById('time-current');
const timeDuration = document.getElementById('time-duration');
const playPauseBtn = document.getElementById('play-pause-btn');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');

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

// Playback Buffers & Sync
let h264FrameQueue = [];
let vevcFrameQueue = [];
let isBuffering = true;
let isPlaying = false;
let presentationTimer = null;
const BUFFER_TARGET = 3;
const BUFFER_MAX = 30;
const bufferingIndicator = document.getElementById('buffering-indicator');

// End-to-end backpressure: tracks frames submitted to VEVC Worker
// that have not yet produced decoded output.
// This prevents Swift AsyncStream from accumulating unbounded frames in memory.
let vevcInflight = 0;
const INFLIGHT_MAX = 30;

// Worker setup
const vevcWorker = new Worker('worker.js?v=8', { type: 'module' });
let vevcReady = false;

vevcWorker.onmessage = (e) => {
    const { type, payload } = e.data;
    if (type === 'vevc-ready') {
        vevcReady = true;
        if (uploadInput.files.length) {
            startBtn.disabled = false;
        }
    } else if (type === 'vevc-chunk') {
        vevcTotalBits += payload.byteLength * 8;
        vevcStats.textContent = `Bits: ${vevcTotalBits.toLocaleString()}`;
    } else if (type === 'vevc-frame') {
        const { width, height, data } = payload;
        vevcFrameQueue.push({ width, height, data });
        if (vevcCanvas.width !== width || vevcCanvas.height !== height) {
            vevcCanvas.width = width;
            vevcCanvas.height = height;
        }
    } else if (type === 'vevc-inflight') {
        vevcInflight = payload;
    } else if (type === 'vevc-error') {
        console.error("VEVC Error:", payload);
    }
};

uploadInput.addEventListener('change', () => {
    if (uploadInput.files.length) {
        const url = URL.createObjectURL(uploadInput.files[0]);
        sourceVideo.src = url;
        if (vevcReady) {
            startBtn.disabled = false;
        }
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
            // Enforce buffer limit: drop oldest frames to prevent VideoFrame resource leak
            while (BUFFER_MAX <= h264FrameQueue.length) {
                const dropped = h264FrameQueue.shift();
                try { dropped.close(); } catch(e){}
            }
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
        latencyMode: "realtime"
    });
}

// ─── Time Formatting ────────────────────────────────

function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function updateTimeDisplay(timeSec) {
    const dur = sourceVideo.duration || 0;
    timeCurrent.textContent = formatTime(timeSec);
    timeDuration.textContent = formatTime(dur);
    if (0 < dur) {
        const pct = (timeSec / dur) * 1000;
        seekBar.value = pct;
        seekbarProgress.style.width = (pct / 10) + '%';
    }
}

// ─── Play/Pause Controls ────────────────────────────

function setPlayingState(playing) {
    isPlaying = playing;
    if (playing) {
        playIcon.style.display = 'none';
        pauseIcon.style.display = 'block';
    } else {
        playIcon.style.display = 'block';
        pauseIcon.style.display = 'none';
    }
}

playPauseBtn.addEventListener('click', () => {
    if (isPlaying) {
        setPlayingState(false);
    } else {
        setPlayingState(true);
    }
});

// ─── Seek Controls ──────────────────────────────────

seekBar.addEventListener('input', (e) => {
    const permille = parseFloat(e.target.value);
    const dur = sourceVideo.duration || 0;
    const targetTime = (permille / 1000) * dur;
    seekTargetTime = targetTime;
    // Update time display immediately for responsive feedback
    timeCurrent.textContent = formatTime(targetTime);
    seekbarProgress.style.width = (permille / 10) + '%';
});

seekBar.addEventListener('change', (e) => {
    if (0 <= seekTargetTime) {
        const target = seekTargetTime;
        seekTargetTime = -1;
        if (activePipeline) {
            setupPipelinesAndPlay(target);
        }
    }
});

// ─── Comparison Pipeline ────────────────────────────

function startComparison() {
    activePipeline = true;
    h264TotalBits = 0;
    vevcTotalBits = 0;
    sourceVideo.currentTime = 0;
    
    if (1 <= sourceVideo.readyState) {
        setupPipelinesAndPlay(0);
    } else {
        sourceVideo.onloadedmetadata = () => setupPipelinesAndPlay(0);
    }
}

let currentPresentationTime = 0;

function setupPipelinesAndPlay(startTime) {
    // Clear existing presentation loop and queues
    if (presentationTimer) clearInterval(presentationTimer);
    h264FrameQueue.forEach(f => { try { f.close(); } catch(e){} });
    h264FrameQueue = [];
    vevcFrameQueue = [];
    vevcInflight = 0;
    isBuffering = true;
    bufferingIndicator.style.display = 'flex';
    
    const width = sourceVideo.videoWidth;
    const height = sourceVideo.videoHeight;
    const bitrate = parseInt(bitrateInput.value, 10) * 1000;
    const framerate = parseInt(framerateInput.value, 10);
    
    initH264Pipeline(width, height, bitrate, framerate);
    
    // Initialize VEVC via Worker
    vevcWorker.postMessage({
        type: 'init-vevc',
        payload: { width, height, bitrate, framerate }
    });
    
    sourceVideo.pause();
    
    // Offscreen canvas for pixel extraction
    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = width;
    offscreenCanvas.height = height;
    const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    
    const interval = 1 / framerate;
    currentPresentationTime = startTime;
    updateTimeDisplay(currentPresentationTime);
    
    // Enable playback controls
    playPauseBtn.disabled = false;
    setPlayingState(true);
    
    // Track total frames for stats
    let extractedFrameCount = 0;
    const totalExpectedFrames = Math.ceil((sourceVideo.duration - startTime) * framerate);
    
    // 1. Data Producer Loop
    // Runs ahead of playback, extracting frames and feeding them to both encoder pipelines.
    // Backpressure prevents memory exhaustion by waiting when output queues are saturated.
    async function extractFramesLoop() {
        let t = startTime;
        const dur = sourceVideo.duration || 10;
        
        while (t < dur && activePipeline && seekTargetTime === -1) {
            // Backpressure: wait when output buffers or VEVC pipeline are saturated.
            // vevcInflight tracks frames submitted to Worker but not yet decoded,
            // preventing Swift AsyncStream from accumulating unbounded data in WASM memory.
            while (activePipeline && seekTargetTime === -1) {
                const h264Full = BUFFER_MAX < h264FrameQueue.length;
                const vevcFull = BUFFER_MAX < vevcFrameQueue.length;
                const encoderFull = h264Encoder && 10 < h264Encoder.encodeQueueSize;
                const inflightFull = INFLIGHT_MAX < vevcInflight;
                
                if (h264Full || vevcFull || encoderFull || inflightFull) {
                    await new Promise(r => setTimeout(r, 50));
                    continue;
                }
                break;
            }
            if (seekTargetTime !== -1) break;
            if (activePipeline === false) break;
            
            // Seek source video to the target timestamp
            sourceVideo.currentTime = t;
            await new Promise((resolve) => {
                sourceVideo.addEventListener('seeked', resolve, { once: true });
            });
            if (seekTargetTime !== -1) break;
            if (activePipeline === false) break;
            
            try {
                if (sourceVideo.videoWidth === 0) throw new Error("Video not ready");
                
                // H264 pipeline: create VideoFrame and encode
                const frame = new VideoFrame(sourceVideo, { timestamp: t * 1e6 });
                if (h264Encoder.state === "configured") {
                     h264Encoder.encode(frame);
                }
                frame.close();
                
                // VEVC pipeline: extract raw RGBA pixels and send to worker
                ctx.drawImage(sourceVideo, 0, 0, width, height);
                const imgData = ctx.getImageData(0, 0, width, height);
                
                vevcWorker.postMessage({
                    type: 'encode-frame',
                    payload: { data: imgData.data }
                }, [imgData.data.buffer]);
                
                extractedFrameCount++;
                
            } catch (err) {
                console.error("Frame extraction error at t=" + t.toFixed(3), err);
            }
            t += interval;
        }
        
        console.log(`[Main] Frame extraction complete. Total: ${extractedFrameCount} frames`);
        
        // Flush the H264 encoder to ensure all buffered frames are output
        if (h264Encoder && h264Encoder.state === 'configured') {
            try { await h264Encoder.flush(); } catch(e) {}
        }
        
        // Flush the VEVC pipeline: close encoder/decoder so Swift AsyncStream flushes
        // remaining frames through the pipeline
        if (seekTargetTime === -1 && activePipeline) {
            vevcWorker.postMessage({ type: 'flush-vevc' });
        }
    }
    
    extractFramesLoop();
    
    // 2. Presentation Loop at playback framerate
    // Dequeues one frame from each pipeline per tick, drawing them synchronously
    // to maintain frame-level alignment between H264 and VEVC.
    const renderInterval = 1000 / framerate;
    presentationTimer = setInterval(() => {
        if (activePipeline === false) return;
        if (seekTargetTime !== -1) return;
        
        // Pause: skip rendering but keep timer alive
        if (isPlaying === false) return;
        
        if (isBuffering) {
            // Use lower threshold (1 frame) for re-buffering to avoid chattering
            // when VEVC decode is slower than H264
            if (1 <= h264FrameQueue.length && 1 <= vevcFrameQueue.length) {
                isBuffering = false;
                bufferingIndicator.style.display = 'none';
            } else {
                return; // Keep buffering
            }
        }
        
        if (0 < h264FrameQueue.length && 0 < vevcFrameQueue.length) {
            // Both queues have frames: synchronous frame-by-frame rendering
            const h264Frame = h264FrameQueue.shift();
            const vevcPayload = vevcFrameQueue.shift();
            
            h264Ctx.drawImage(h264Frame, 0, 0, width, height);
            h264Frame.close();
            
            const vevcImgData = new ImageData(new Uint8ClampedArray(vevcPayload.data), vevcPayload.width, vevcPayload.height);
            vevcCtx.putImageData(vevcImgData, 0, 0);
            
            currentPresentationTime += interval;
            updateTimeDisplay(currentPresentationTime);
        } else if (0 < h264FrameQueue.length || 0 < vevcFrameQueue.length) {
            // Partial data: one pipeline is ahead of the other.
            // Draw whichever is available and advance time to avoid stalling.
            if (0 < h264FrameQueue.length) {
                const h264Frame = h264FrameQueue.shift();
                h264Ctx.drawImage(h264Frame, 0, 0, width, height);
                h264Frame.close();
            }
            if (0 < vevcFrameQueue.length) {
                const vevcPayload = vevcFrameQueue.shift();
                const vevcImgData = new ImageData(new Uint8ClampedArray(vevcPayload.data), vevcPayload.width, vevcPayload.height);
                vevcCtx.putImageData(vevcImgData, 0, 0);
            }
            currentPresentationTime += interval;
            updateTimeDisplay(currentPresentationTime);
        } else {
            // Both queues empty — re-enter buffering state
            isBuffering = true;
            bufferingIndicator.style.display = 'flex';
            
            // End of video: if we're past the expected duration, stop
            const endThreshold = (sourceVideo.duration || 10) - interval * 2;
            if (endThreshold <= currentPresentationTime) {
                bufferingIndicator.style.display = 'none';
                clearInterval(presentationTimer);
                setPlayingState(false);
                console.log(`[Main] Playback finished at ${currentPresentationTime.toFixed(2)}s`);
            }
        }
    }, renderInterval);
}
