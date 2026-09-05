/**
 * Two ways to turn speech into text, behind one handler interface:
 *  - AudioRecorder captures audio with MediaRecorder and hands the blob to a transcribe() callback (OpenAI).
 *  - BrowserSpeechRecognizer uses the browser's built-in SpeechRecognition (Chrome, Android Chrome) with no API key.
 * Handlers: onStatus(text), onStart(), onResult({ finalTranscript, interimTranscript, model, provider }), onError(error), onEnd({ transcript, ... }).
 */

export const AudioRecorderConstructor = (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) ? window.MediaRecorder : null;
export const SpeechRecognitionConstructor = window.SpeechRecognition || window.webkitSpeechRecognition || null;

function preferredMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || "";
}

const PERMISSION_MESSAGES = {
  NotAllowedError: "Microphone permission was denied or this connection is not secure. Use HTTPS, localhost, the installed app, or the audio-file control.",
  NotFoundError: "No working microphone was found.",
  NotReadableError: "The microphone is already in use by another app.",
  SecurityError: "The browser blocked microphone access on this connection."
};

export class AudioRecorder {
  constructor(handlers = {}, transcribe) {
    this.handlers = handlers;
    this.transcribe = transcribe;
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.listening = false;
    this.language = "en";
    this.cancelled = false;
  }

  get supported() { return Boolean(AudioRecorderConstructor); }

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
        if (this.cancelled) return this.handlers.onEnd?.({ transcript: "", cancelled: true });
        try {
          this.handlers.onStatus?.("Transcribing the recording…");
          const result = await this.transcribe(blob, { language: this.language });
          this.handlers.onResult?.({ finalTranscript: result.transcript, interimTranscript: "", model: result.model, provider: result.provider });
          this.handlers.onEnd?.({ transcript: result.transcript, model: result.model, provider: result.provider });
        } catch (error) {
          this.handlers.onError?.(error);
          this.handlers.onEnd?.({ transcript: "", error: true });
        }
      }, { once: true });
      this.recorder.start(250);
      this.listening = true;
      this.handlers.onStart?.();
    } catch (error) {
      this.stream?.getTracks().forEach(track => track.stop());
      this.stream = null;
      throw new Error(PERMISSION_MESSAGES[error?.name] || error?.message || "Could not start audio recording.");
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

export class BrowserSpeechRecognizer {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.recognition = null;
    this.listening = false;
    this.finalTranscript = "";
    this.cancelled = false;
  }

  get supported() { return Boolean(SpeechRecognitionConstructor); }

  async start(options = {}) {
    if (!this.supported) throw new Error("This browser has no built-in speech recognition. Use OpenAI transcription or type the command.");
    if (this.listening) return;
    const recognition = new SpeechRecognitionConstructor();
    recognition.lang = options.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    this.finalTranscript = "";
    this.cancelled = false;
    recognition.onstart = () => { this.listening = true; this.handlers.onStart?.(); };
    recognition.onresult = event => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const text = event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) this.finalTranscript = `${this.finalTranscript} ${text}`.trim();
        else interim += text;
      }
      this.handlers.onResult?.({ finalTranscript: this.finalTranscript, interimTranscript: interim, model: "browser-speech-recognition", provider: "Browser" });
    };
    recognition.onerror = event => {
      const messages = { "not-allowed": PERMISSION_MESSAGES.NotAllowedError, "audio-capture": PERMISSION_MESSAGES.NotFoundError, network: "Speech recognition needs a network connection in this browser.", "no-speech": "No speech was detected." };
      if (event.error !== "aborted") this.handlers.onError?.(new Error(messages[event.error] || `Speech recognition failed (${event.error}).`));
    };
    recognition.onend = () => {
      this.listening = false;
      this.recognition = null;
      this.handlers.onEnd?.({ transcript: this.cancelled ? "" : this.finalTranscript, cancelled: this.cancelled, model: "browser-speech-recognition", provider: "Browser" });
    };
    this.recognition = recognition;
    this.handlers.onStatus?.("Listening with the browser's speech recognition…");
    recognition.start();
  }

  stop() {
    this.handlers.onStatus?.("Finishing…");
    this.recognition?.stop();
  }

  abort() {
    this.cancelled = true;
    this.recognition?.abort();
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
