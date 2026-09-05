const safeText = value => String(value || "").trim();

// The recorder used for live capture (audio is transcribed server-side by OpenAI; no browser speech recognition is involved).
export const AudioRecorderConstructor = (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) ? window.MediaRecorder : null;

function preferredMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || "";
}

export async function transcribeAudioBlob(blob, options = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("The audio recording was empty.");
  const response = await fetch("/api/voice/transcribe", {
    method: "POST",
    headers: {
      "Content-Type": blob.type || options.contentType || "audio/webm",
      "X-Transcription-Language": String(options.language || "en").slice(0, 16)
    },
    body: blob
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "OpenAI transcription failed.");
  const transcript = safeText(data.transcript);
  if (!transcript) throw new Error("No speech was recognized in the recording.");
  return { transcript, model: data.model || "OpenAI transcription", provider: data.provider || "OpenAI" };
}

export class VoiceTranscriber {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.listening = false;
    this.language = "en";
    this.cancelled = false;
  }

  get supported() {
    return Boolean(AudioRecorderConstructor);
  }

  async start(options = {}) {
    if (!this.supported) throw new Error("Audio recording is not supported in this browser. Use the audio-file button or type the command instead.");
    if (this.listening) return;
    this.language = options.language || "en";
    this.cancelled = false;
    this.handlers.onStatus?.("Requesting microphone permission…");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const mimeType = preferredMimeType();
      this.recorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);
      this.chunks = [];
      this.recorder.addEventListener("dataavailable", event => { if (event.data?.size) this.chunks.push(event.data); });
      this.recorder.addEventListener("error", event => this.handlers.onError?.(new Error(event.error?.message || "Audio recording failed.")));
      this.recorder.addEventListener("stop", async () => {
        this.listening = false;
        this.stream?.getTracks().forEach(track => track.stop());
        const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || mimeType || "audio/webm" });
        this.recorder = null;
        this.stream = null;
        if (this.cancelled) return this.handlers.onEnd?.({ transcript: "", localMode: false, cancelled: true });
        try {
          this.handlers.onStatus?.("OpenAI is transcribing the recording…");
          const result = await transcribeAudioBlob(blob, { language: this.language });
          this.handlers.onResult?.({ finalTranscript: result.transcript, interimTranscript: "", model: result.model, provider: result.provider });
          this.handlers.onEnd?.({ transcript: result.transcript, localMode: false, model: result.model, provider: result.provider });
        } catch (error) {
          this.handlers.onError?.(error);
          this.handlers.onEnd?.({ transcript: "", localMode: false, error: true });
        }
      }, { once: true });
      this.recorder.start(250);
      this.listening = true;
      this.handlers.onStart?.({ localMode: false });
    } catch (error) {
      this.stream?.getTracks().forEach(track => track.stop());
      this.stream = null;
      const messages = {
        NotAllowedError: "Microphone permission was denied or this connection is not secure. Use HTTPS, localhost, or the audio-file recorder.",
        NotFoundError: "No working microphone was found.",
        NotReadableError: "The microphone is already in use by another app.",
        SecurityError: "The browser blocked microphone access on this connection."
      };
      throw new Error(messages[error?.name] || error?.message || "Could not start audio recording.");
    }
  }

  stop() {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.handlers.onStatus?.("Finishing recording…");
      this.recorder.stop();
    }
  }

  abort() {
    this.cancelled = true;
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop());
  }
}

export function speakText(text, options = {}) {
  if (!("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(String(text));
  utterance.lang = options.language || "en-US";
  utterance.rate = Number(options.rate || 1);
  utterance.pitch = Number(options.pitch || 1);
  window.speechSynthesis.speak(utterance);
}
