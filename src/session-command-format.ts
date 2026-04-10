export const SESSION_COMMAND_PREFIX = '!';

export function formatSessionCommand(name: string, args?: string): string {
  return `${SESSION_COMMAND_PREFIX}${name}${args ? ` ${args}` : ''}`;
}
