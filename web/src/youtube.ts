declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<typeof YT> | null = null;

/** Loads the IFrame Player API once and resolves with the global `YT`. */
export function loadYouTubeApi(): Promise<typeof YT> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  loading ??= new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      loading = null;
      reject(new Error("Couldn't load the YouTube player"));
    };
    document.head.append(script);
  });
  return loading;
}
