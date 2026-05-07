/**
 * Legacy duplicate kept only so any stray imports still fail predictably.
 * The real implementation lives in ./threads.
 */
export async function publish(_text: string): Promise<string> {
  throw new Error('Use ./threads instead of ./threadss');
}
