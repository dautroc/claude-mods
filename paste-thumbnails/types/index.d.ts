// A pixel size.
export type Size = { width: number; height: number }

// The thumbnail of one image pasted into the prompt box: the number its
// `[Image #N]` tag carries, a small PNG of it (base64) and that PNG's size,
// and the size of the image as pasted.
export type Thumb = { id: number; png: string; size: Size; pasted: Size }

declare module 'claude-code' {
  interface PluginState {
    'paste-thumbnails': { thumbs: Shaped<Thumb[]> }
  }
}
