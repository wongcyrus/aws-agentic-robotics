import { z } from 'zod';

export const PopupMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PLAYER_READY') }),
  z.object({ type: z.literal('PLAY_VIDEO'), videoSrc: z.string() }),
  z.object({ type: z.literal('STOP_VIDEO') })
]);
export type PopupMessage = z.infer<typeof PopupMessageSchema>;
export const popupOrigin = () => window.location.origin;
export function postToPopup(target: Window, message: PopupMessage) {
  target.postMessage(PopupMessageSchema.parse(message), popupOrigin());
}
export function readPopupMessage(event: MessageEvent, expectedSource?: Window | null) {
  if (event.origin !== popupOrigin()) return null;
  if (expectedSource && event.source !== expectedSource) return null;
  const parsed = PopupMessageSchema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}
