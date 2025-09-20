import { createFFmpeg, fetchFile } from "https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/esm/index.js?module";

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

let ffmpegInstance;
let ffmpegLoaded = false;
let currentObjectUrl = null;
let selectedFile = null;

const initFFmpeg = async () => {
    if (ffmpegLoaded) return;

    statusMessage.textContent = "Summoning ffmpeg spellbook...";
    convertBtn.disabled = true;

    ffmpegInstance = createFFmpeg({
        log: true,
        corePath: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js",
    });

    ffmpegInstance.setProgress(({ ratio }) => {
        const percent = Math.min(100, Math.round(ratio * 100));
        progressFill.style.width = `${percent}%`;
        progressLabel.textContent = `${percent}%`;
    });

    try {
        await ffmpegInstance.load();
        ffmpegLoaded = true;
        statusMessage.textContent = "Spellbook ready. Choose your format.";
    } catch (error) {
        console.error(error);
        statusMessage.textContent = "The arcane library is out of reach. Check your connection and try again.";
        throw error;
    } finally {
        convertBtn.disabled = !selectedFile;
    }
};

const resetProgress = () => {
    progressFill.style.width = "0%";
    progressLabel.textContent = "0%";
};

fileInput.addEventListener("change", (event) => {
    selectedFile = event.target.files?.[0] ?? null;
    resultBox.hidden = true;
    progressGroup.hidden = true;
    resetProgress();
    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
    }

    if (selectedFile) {
        convertBtn.disabled = false;
        statusMessage.textContent = `Offering received: ${selectedFile.name}`;
    } else {
        convertBtn.disabled = true;
        statusMessage.textContent = "Awaiting your video...";
    }
});

const highlightDropzone = (isActive) => {
    if (!dropzone) return;
    dropzone.style.borderColor = isActive ? "rgba(214, 166, 71, 0.85)" : "rgba(214, 166, 71, 0.5)";
    dropzone.style.background = isActive ? "rgba(40, 22, 18, 0.85)" : "rgba(28, 15, 11, 0.65)";
};

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
    if (!selectedFile) return;

    try {
        await initFFmpeg();
    } catch (error) {
        convertBtn.disabled = false;
        return;
    }

    const format = new FormData(form).get("format")?.toString() ?? "mp3";
    const outputExt = format === "wav" ? "wav" : "mp3";
    const mimeType = outputExt === "wav" ? "audio/wav" : "audio/mpeg";
    const inputExt = selectedFile.name.split(".").pop()?.toLowerCase() || "mp4";
    const inputName = `input.${inputExt}`;
    const outputName = `output.${outputExt}`;

    convertBtn.disabled = true;
    statusMessage.textContent = "Brewing your audio potion...";
    progressGroup.hidden = false;
    resetProgress();
    resultBox.hidden = true;

    try {
        ffmpegInstance.FS("writeFile", inputName, await fetchFile(selectedFile));

        const args =
            outputExt === "mp3"
                ? ["-i", inputName, "-vn", "-acodec", "libmp3lame", "-b:a", "192k", outputName]
                : ["-i", inputName, "-vn", "-acodec", "pcm_s16le", "-ar", "44100", outputName];

        await ffmpegInstance.run(...args);
        const data = ffmpegInstance.FS("readFile", outputName);
        const blob = new Blob([data.buffer], { type: mimeType });

        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
        }
        currentObjectUrl = URL.createObjectURL(blob);

        downloadLink.href = currentObjectUrl;
        downloadLink.download = `${selectedFile.name.replace(/\.[^/.]+$/, "") || "audio"}.${outputExt}`;
        downloadLink.textContent = `Download ${outputExt.toUpperCase()}`;

        statusMessage.textContent = "Transmutation complete.";
        progressFill.style.width = "100%";
        progressLabel.textContent = "100%";
        resultBox.hidden = false;
    } catch (error) {
        console.error(error);
        statusMessage.textContent = "The ritual faltered. Please try again with a different file.";
        resetProgress();
    } finally {
        try {
            ffmpegInstance.FS("unlink", inputName);
            ffmpegInstance.FS("unlink", outputName);
        } catch (cleanupError) {
            // ignore cleanup failures
        }
        convertBtn.disabled = false;
    }
});
