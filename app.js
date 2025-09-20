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
const hiddenVideo = document.getElementById("hidden-video");
const dropzone = document.querySelector(".dropzone");

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const supportsWebAudio = typeof AudioContextClass === "function";
let audioContext;
let currentObjectUrl = null;
let selectedFile = null;

const supportsCapture =
    typeof MediaRecorder !== "undefined" &&
    (typeof hiddenVideo?.captureStream === "function" || typeof hiddenVideo?.mozCaptureStream === "function");

const ensureAudioContext = () => {
    if (!supportsWebAudio) {
        throw new Error("Web Audio support is required for this ritual.");
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
    new Promise((resolve) => target.addEventListener(eventName, resolve, { once: true }));

const getCaptureStream = (video) => {
    if (typeof video.captureStream === "function") return video.captureStream();
    if (typeof video.mozCaptureStream === "function") return video.mozCaptureStream();
    return null;
};

const decodeFileWithWebAudio = async (file) => {
    const ctx = await resumeAudioContextIfNeeded();
    const arrayBuffer = await file.arrayBuffer();
    if (!arrayBuffer.byteLength) {
        throw new Error("The offered file appears empty.");
    }
    return ctx.decodeAudioData(arrayBuffer.slice(0));
};

const decodeBlobToAudioBuffer = async (blob) => {
    const ctx = await resumeAudioContextIfNeeded();
    const buffer = await blob.arrayBuffer();
    return ctx.decodeAudioData(buffer.slice(0));
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

const writeString = (view, offset, string) => {
    for (let i = 0; i < string.length; i += 1) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
};

const encodeWav = (audioBuffer) => {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const interleaved = interleaveChannels(audioBuffer);
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + interleaved.length * bytesPerSample);
    const view = new DataView(buffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + interleaved.length * bytesPerSample, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, "data");
    view.setUint32(40, interleaved.length * bytesPerSample, true);

    let offset = 44;
    for (let i = 0; i < interleaved.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, interleaved[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += bytesPerSample;
    }

    return new Blob([buffer], { type: "audio/wav" });
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
    if (!window.lamejs || typeof window.lamejs.Mp3Encoder !== "function") {
        throw new Error("MP3 encoder library missing. Please reload the page.");
    }
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const bitrate = 128;
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

const selectRecorderMimeType = () => {
    const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
    for (const type of candidates) {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
            return type;
        }
    }
    return "";
};

const recordAudioFromVideo = (video, mimeType) =>
    new Promise((resolve, reject) => {
        const stream = getCaptureStream(video);
        if (!stream) {
            reject(new Error("Unable to capture audio from this browser."));
            return;
        }
        if (stream.getAudioTracks().length === 0) {
            reject(new Error("No audio track detected in this video."));
            return;
        }

        let recorder;
        try {
            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        } catch (error) {
            reject(error);
            return;
        }

        const chunks = [];
        const handleData = (event) => {
            if (event.data && event.data.size) {
                chunks.push(event.data);
            }
        };
        const handleError = (event) => {
            recorder.removeEventListener("dataavailable", handleData);
            recorder.removeEventListener("error", handleError);
            recorder.removeEventListener("stop", handleStop);
            reject(event.error || new Error("Recorder error occurred."));
        };
        const handleStop = () => {
            recorder.removeEventListener("dataavailable", handleData);
            recorder.removeEventListener("error", handleError);
            recorder.removeEventListener("stop", handleStop);
            resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
        };

        recorder.addEventListener("dataavailable", handleData);
        recorder.addEventListener("error", handleError);
        recorder.addEventListener("stop", handleStop);

        const stopRecording = () => {
            if (recorder.state !== "inactive") {
                recorder.stop();
            }
        };

        video.addEventListener(
            "ended",
            () => {
                stopRecording();
            },
            { once: true }
        );
        video.addEventListener(
            "error",
            () => {
                stopRecording();
                reject(new Error("Video playback failed."));
            },
            { once: true }
        );

        try {
            recorder.start();
        } catch (error) {
            reject(error);
            return;
        }

        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch((error) => {
                stopRecording();
                reject(error);
            });
        }
    });

const captureAudioBufferViaPlayback = async (file) => {
    if (!hiddenVideo) {
        throw new Error("Fallback playback element missing.");
    }
    let videoUrl;
    const detachProgress = (() => {
        const handler = () => {
            if (!Number.isFinite(hiddenVideo.duration) || hiddenVideo.duration === 0) return;
            const percent = (hiddenVideo.currentTime / hiddenVideo.duration) * 90;
            updateProgress(percent);
        };
        hiddenVideo.addEventListener("timeupdate", handler);
        hiddenVideo.addEventListener("ended", handler);
        return () => {
            hiddenVideo.removeEventListener("timeupdate", handler);
            hiddenVideo.removeEventListener("ended", handler);
        };
    })();

    try {
        videoUrl = URL.createObjectURL(file);
        hiddenVideo.src = videoUrl;
        hiddenVideo.currentTime = 0;
        hiddenVideo.volume = 0;
        hiddenVideo.muted = true;

        await waitForEvent(hiddenVideo, "loadedmetadata");
        updateProgress(5);

        const mimeType = selectRecorderMimeType();
        const recordedBlob = await recordAudioFromVideo(hiddenVideo, mimeType);
        updateProgress(95);

        return decodeBlobToAudioBuffer(recordedBlob);
    } finally {
        detachProgress();
        hiddenVideo.pause();
        hiddenVideo.removeAttribute("src");
        hiddenVideo.load();
        if (videoUrl) {
            URL.revokeObjectURL(videoUrl);
        }
    }
};

const highlightDropzone = (isActive) => {
    if (!dropzone) return;
    dropzone.style.borderColor = isActive ? "rgba(214, 166, 71, 0.85)" : "rgba(214, 166, 71, 0.5)";
    dropzone.style.background = isActive ? "rgba(40, 22, 18, 0.85)" : "rgba(28, 15, 11, 0.65)";
};

if (!supportsWebAudio) {
    convertBtn.disabled = true;
    statusMessage.textContent = "This ritual requires a modern browser with Web Audio support.";
}

fileInput.addEventListener("change", (event) => {
    selectedFile = event.target.files?.[0] ?? null;
    resultBox.hidden = true;
    resetProgress();
    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
    }

    if (selectedFile) {
        convertBtn.disabled = !supportsWebAudio;
        statusMessage.textContent = supportsWebAudio
            ? `Offering received: ${selectedFile.name}`
            : "This ritual requires a modern browser with Web Audio support.";
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
    if (!selectedFile || !supportsWebAudio) return;

    convertBtn.disabled = true;
    statusMessage.textContent = "Consulting the arcane archives...";
    resultBox.hidden = true;
    progressGroup.hidden = false;
    updateProgress(5);

    const formatChoice = new FormData(form).get("format")?.toString() ?? "mp3";
    const outputExt = formatChoice === "wav" ? "wav" : "mp3";

    try {
        let audioBuffer;

        try {
            audioBuffer = await decodeFileWithWebAudio(selectedFile);
            updateProgress(60);
        } catch (decodeError) {
            console.warn("Direct decode failed, attempting playback capture.", decodeError);
            if (!supportsCapture) {
                throw new Error(
                    "Your browser cannot extract audio from this format. Try Chrome or Edge, or use a different file."
                );
            }
            statusMessage.textContent = "Direct decoding resisted. Invoking live playback capture...";
            audioBuffer = await captureAudioBufferViaPlayback(selectedFile);
        }

        statusMessage.textContent = "Distilling the final potion...";
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
        convertBtn.disabled = !selectedFile || !supportsWebAudio;
    }
});
