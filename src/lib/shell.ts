export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function parseJsonResponse<T>(output: string, resultKey?: string): T {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const response = JSON.parse(lines[index]);
      if (response.error) {
        throw new Error(response.error.message ?? response.error.code ?? 'Herdr command failed');
      }
      const result = response.result ?? response;
      return (resultKey ? result[resultKey] : result) as T;
    } catch (error) {
      if (error instanceof SyntaxError) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(output.trim() || 'The remote command returned no data');
}
