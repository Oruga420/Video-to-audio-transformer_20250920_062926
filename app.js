const form = document.getElementById("converter-form");
const fileInput = document.getElementById("video-input");
const convertBtn = form.querySelector(".convert-btn");
const statusBox = document.getElementById("status");
const statusMessage = statusBox.querySelector(".status__message");
const progressGroup = statusBox.querySelector(".status__progress");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const resultBox = document.getElementById("result");
const downloadLink = document.getElementById("download-link");
const dropzone = document.querySelector(".dropzone");

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const supportsWebAudio = typeof AudioContextClass === "function";
const supportsMediaRecorder = typeof MediaRecorder !== "undefined";
const supportsLame = () => window.lamejs && typeof window.lamejs.Mp3Encoder === "function";

let audioContext;
let selectedFile = null;
let currentObjectUrl = null;

const ensureAudioContext = () => {
    if (!supportsWebAudio) {
        throw new Error("Web Audio support missing.");
    }
    if (!audioContext || audioContext.state === "closed") {
        audioContext = new AudioContextClass();
    }
    return audioContext;
};

const resumeAudioContextIfNeeded = async () => {
    const ctx = ensureAudioContext();
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
        await ctx.resume();
    }
    return ctx;
};

const updateProgress = (percent) => {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    progressFill.style.width = `${safePercent}%`;
    progressLabel.textContent = `${safePercent}%`;
};

const resetProgress = () => {
    progressGroup.hidden = true;
    updateProgress(0);
};

const waitForEvent = (target, eventName) =>
    new Promise((resolve, reject) => {
        const handleResolve = (event) => {
            cleanup();
            resolve(event);
        };
        const handleReject = (event) => {
            cleanup();
            reject(event instanceof Error ? event : event?.error || new Error(`${eventName} failed`));
        };
        const cleanup = () => {
            target.removeEventListener(eventName, handleResolve);
            target.removeEventListener("error", handleReject);
        };
        target.addEventListener(eventName, handleResolve, { once: true });
        target.addEventListener("error", handleReject, { once: true });
    });

const selectRecorderMimeType = () => {
    const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
    for (const type of candidates) {
        if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type)) {
            return type;
        }
    }
    return "";
};

const floatToInt16 = (buffer) => {
    const result = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, buffer[i]));
        result[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return result;
};

const encodeMp3 = (audioBuffer) => {
    if (!supportsLame()) {
        throw new Error("MP3 encoder library missing. Please reload the page.");
    }
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const bitrate = 160;
    const encoder = new window.lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
    const blockSize = 1152;
    const left = audioBuffer.getChannelData(0);
    const right = numChannels > 1 ? audioBuffer.getChannelData(1) : null;
    const mp3Data = [];

    for (let i = 0; i < left.length; i += blockSize) {
        const leftChunk = floatToInt16(left.subarray(i, i + blockSize));
        let buffer;
        if (numChannels > 1 && right) {
            const rightChunk = floatToInt16(right.subarray(i, i + blockSize));
            buffer = encoder.encodeBuffer(leftChunk, rightChunk);
        } else {
            buffer = encoder.encodeBuffer(leftChunk);
        }
        if (buffer.length > 0) {
            mp3Data.push(buffer);
        }
    }

    const flushBuffer = encoder.flush();
    if (flushBuffer.length > 0) {
        mp3Data.push(flushBuffer);
    }

    return new Blob(mp3Data, { type: "audio/mpeg" });
};

const interleaveChannels = (audioBuffer) => {
    const { numberOfChannels, length } = audioBuffer;
    if (numberOfChannels === 1) {
        return audioBuffer.getChannelData(0);
    }
    const result = new Float32Array(length * numberOfChannels);
    const channelData = [];
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
        channelData.push(audioBuffer.getChannelData(channel));
    }
    for (let i = 0; i < length; i += 1) {
        for (let channel = 0; channel < numberOfChannels; channel += 1) {
            result[i * numberOfChannels + channel] = channelData[channel][i];
        }
    }
    return result;
};

const encodeWav = (audioBuffer) => {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const interleaved = interleaveChannels(audioBuffer);
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + interleaved.length * bytesPerSample);
    const view = new DataView(buffer);

    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i += 1) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + interleaved.length * bytesPerSample, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, interleaved.length * bytesPerSample, true);

    let offset = 44;
    for (let i = 0; i < interleaved.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, interleaved[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += bytesPerSample;
    }

    return new Blob([buffer], { type: "audio/wav" });
};

const decodeBlobToAudioBuffer = async (blob) => {
    const ctx = await resumeAudioContextIfNeeded();
    const arrayBuffer = await blob.arrayBuffer();
    if (!arrayBuffer.byteLength) {
        throw new Error("Captured audio stream was empty.");
    }
    return ctx.decodeAudioData(arrayBuffer.slice(0));
};

const captureAudioFromFile = async (file, handleProgress) => {
    if (!supportsMediaRecorder) {
        throw new Error("MediaRecorder support missing in this browser.");
    }

    const ctx = await resumeAudioContextIfNeeded();
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.hidden = true;
    video.crossOrigin = "anonymous";
    document.body.appendChild(video);
    video.src = objectUrl;

    let recorder;
    let source;
    let destination;
    let silencer;
    let handleTimeUpdate;

    const cleanup = () => {
        if (handleTimeUpdate) {
            video.removeEventListener("timeupdate", handleTimeUpdate);
        }
        try {
            if (recorder && recorder.state !== "inactive") {
                recorder.stop();
            }
        } catch (error) {
            // ignore stopping error
        }
        if (source) {
            try {
                source.disconnect();
            } catch (error) {
                // ignore
            }
        }
        if (silencer) {
            try {
                silencer.disconnect();
            } catch (error) {
                // ignore
            }
        }
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.remove();
        URL.revokeObjectURL(objectUrl);
    };

    try {
        await waitForEvent(video, "loadedmetadata");
        handleProgress?.(5);

        source = ctx.createMediaElementSource(video);
        destination = ctx.createMediaStreamDestination();
        silencer = ctx.createGain();
        silencer.gain.value = 0;

        source.connect(destination);
        source.connect(silencer);
        silencer.connect(ctx.destination);

        const mimeType = selectRecorderMimeType();
        try {
            recorder = mimeType ? new MediaRecorder(destination.stream, { mimeType }) : new MediaRecorder(destination.stream);
        } catch (error) {
            throw new Error("Unable to start the recording ritual in this browser.");
        }

        const chunks = [];
        recorder.addEventListener("dataavailable", (event) => {
            if (event.data && event.data.size) {
                chunks.push(event.data);
            }
        });

        const recordPromise = new Promise((resolve, reject) => {
            recorder.addEventListener("stop", () => {
                const type = recorder.mimeType || mimeType || "audio/webm";
                resolve(new Blob(chunks, { type }));
            });
            recorder.addEventListener("error", (event) => {
                reject(event.error || new Error("Recorder error occurred."));
            });
        });

        handleTimeUpdate = () => {
            if (!Number.isFinite(video.duration) || video.duration <= 0) return;
            const percent = Math.min(95, (video.currentTime / video.duration) * 95);
            handleProgress?.(percent);
        };
        video.addEventListener("timeupdate", handleTimeUpdate);

        const endedPromise = new Promise((resolve, reject) => {
            video.addEventListener(
                "ended",
                () => {
                    handleProgress?.(95);
                    if (recorder.state !== "inactive") {
                        recorder.stop();
                    }
                    resolve();
                },
                { once: true }
            );
            video.addEventListener(
                "error",
                (event) => {
                    reject(event?.error || new Error("Video playback failed."));
                },
                { once: true }
            );
        });

        recorder.start(500);
        await video.play();
        await endedPromise;
        const recordedBlob = await recordPromise;
        handleProgress?.(97);
        return recordedBlob;
    } finally {
        cleanup();
    }
};

const highlightDropzone = (isActive) => {
    if (!dropzone) return;
    dropzone.style.borderColor = isActive ? "rgba(214, 166, 71, 0.85)" : "rgba(214, 166, 71, 0.5)";
    dropzone.style.background = isActive ? "rgba(40, 22, 18, 0.85)" : "rgba(28, 15, 11, 0.65)";
};

if (!supportsWebAudio || !supportsMediaRecorder) {
    convertBtn.disabled = true;
    statusMessage.textContent = "This ritual needs a modern browser with Web Audio and MediaRecorder support.";
}

fileInput.addEventListener("change", (event) => {
    selectedFile = event.target.files?.[0] ?? null;
    resultBox.hidden = true;
    resetProgress();
    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
    }

    if (selectedFile && supportsWebAudio && supportsMediaRecorder) {
        convertBtn.disabled = false;
        statusMessage.textContent = `Offering received: ${selectedFile.name}`;
    } else if (!supportsWebAudio || !supportsMediaRecorder) {
        convertBtn.disabled = true;
    } else {
        convertBtn.disabled = true;
        statusMessage.textContent = "Awaiting your video...";
    }
});

if (dropzone) {
    ["dragenter", "dragover"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            event.stopPropagation();
            highlightDropzone(true);
        });
    });

    ["dragleave", "drop"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            event.stopPropagation();
            highlightDropzone(false);
        });
    });

    dropzone.addEventListener("drop", (event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        fileInput.files = files;
        fileInput.dispatchEvent(new Event("change"));
    });
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedFile || !supportsWebAudio || !supportsMediaRecorder) return;

    convertBtn.disabled = true;
    statusMessage.textContent = "Channeling autumn winds...";
    progressGroup.hidden = false;
    updateProgress(0);
    resultBox.hidden = true;

    const formatChoice = new FormData(form).get("format")?.toString() ?? "mp3";
    const outputExt = formatChoice === "wav" ? "wav" : "mp3";

    try {
        const capturedBlob = await captureAudioFromFile(selectedFile, updateProgress);

        statusMessage.textContent = "Distilling the final potion...";
        updateProgress(98);
        const audioBuffer = await decodeBlobToAudioBuffer(capturedBlob);

        const finalBlob = outputExt === "wav" ? encodeWav(audioBuffer) : encodeMp3(audioBuffer);

        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
        }
        currentObjectUrl = URL.createObjectURL(finalBlob);

        const baseName = selectedFile.name.replace(/\.[^/.]+$/, "");
        downloadLink.href = currentObjectUrl;
        downloadLink.download = `${baseName || "audio"}.${outputExt}`;
        downloadLink.textContent = `Download ${outputExt.toUpperCase()}`;

        updateProgress(100);
        statusMessage.textContent = "Transmutation complete.";
        resultBox.hidden = false;
    } catch (error) {
        console.error(error);
        statusMessage.textContent = error?.message || "The ritual faltered. Please try another file.";
        resetProgress();
    } finally {
        convertBtn.disabled = !selectedFile || !supportsWebAudio || !supportsMediaRecorder;
    }
});
