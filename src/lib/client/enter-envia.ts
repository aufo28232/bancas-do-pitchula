import type { KeyboardEvent } from "react";

/**
 * Chat: Enter envia, Shift+Enter quebra a linha (pedido do streamer, D-089).
 * Não interfere enquanto um teclado de acentos/IME está compondo.
 */
export function enterEnvia(e: KeyboardEvent<HTMLTextAreaElement>): void {
  if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
  e.preventDefault();
  if (!e.currentTarget.value.trim()) return;
  e.currentTarget.form?.requestSubmit();
}
