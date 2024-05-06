export enum Conjunction {
  AND = 'and',
  OR = 'or',
}

/**
 * Converts the array of string items to a single textual string where elements are
 * comma-separated, and an "and" is inserted as necessary., e.g.
 * `['a'] => 'a'`
 * `['a', 'b'] => 'b and c'`
 * `['a', 'b', 'c'] => 'a, b, and c'`
 *
 * Oxford commas are used.
 *
 * @param items - The items to be converted to text
 * @returns The resulting textual string
 */
export function listToText(items: string[], joinWord = Conjunction.AND): string {
  let result;
  if (!items) return '';
  switch (items.length) {
    case 0: return '';
    case 1: return items[0];
    case 2: return items.join(` ${joinWord} `);
    default:
      result = items.concat(); // Copies the array
      result[result.length - 1] = `${joinWord} ${result[result.length - 1]}`;
  }
  return result.join(', ');
}

/**
 * Join sentences or paragraphs (in the specified order) ensuring periods
 * are inserted if no punctuation is present, and a space between texts.
 *
 * @param items - The items to join
 * @returns The resulting textual string
 */
export function joinTexts(...items: string[]): string {
  const result = [];
  for (const item of items) {
    let resultItem = item.trim();
    if (!/[.!?]$/m.test(resultItem)) {
      resultItem += '.';
    }
    result.push(resultItem);
  }
  return result.join(' ');
}

/**
 * Truncates a string to the specified number of characters. The last
 * three characters are replaced with '...'.
 *
 * @param s - The string to truncate
 * @param n - The maximum number of characters to keep
 *
 * @returns The truncated string
 */
export function truncateString(s: string, n: number): string {
  let truncatedString = s;
  if (s.length > n) {
    if (n < 3) {
      truncatedString = '...';
    } else {
      truncatedString = `${s.slice(0, n - 3)}...`;
    }
  }
  return truncatedString;
}

/**
 * Returns true if a string is an integer.
 * @param value - the value to check
 * @returns true if it is an integer and false otherwise
 */
export function isInteger(value: string): boolean {
  return /^-?\d+$/.test(value);
}

/**
 * Returns true if the string is a float (has a decimal point followed by one or more digits).
 * @param value - the value to check
 * @returns true if it is a float and false otherwise
 */
export function isFloat(value: string): boolean {
  return /^[-+]?\d*\.\d+$/.test(value);
}

/**
 * Return true if the string represents a boolean value, e.g., true, True, false, etc.
 * @param value - the value to check
 * @returns true if it is a boolean and false otherwise
 */
export function isBoolean(value: string): boolean {
  return /^true|false$/i.test(value);
}

/**
 * Return the boolean equivalent of the given string. Anything that does not match
 * 'true' (case insensitive) is false.
 * @param value - the value to convert
 * @returns true if the value matches the string 'true' (case insensitive), false
 * otheriwise.
 */
export function parseBoolean(value: string): boolean {
  return /^true$/i.test(value);
}

/**
 * Removes AWS account ECR information or *.earthdata.nasa.gov from image name
 * since we may not want to expose that information.
 *
 * @param image - The image name string to sanitize
 * @returns the sanitized image name
 */
export function sanitizeImage(image: string): string {
  return image
    .replace(/.*amazonaws.com\//, '')
    .replace(/.*ghcr.io\//, '')
    .replace(/.*earthdata.nasa.gov\//, '');
}

/**
 * Returns true if the image repository for the given image is ECR
 *
 * @param image - the full image string
 * @returns true if the image is in ECR and false otherwise
 */
export function inEcr(image: string): boolean {
  return /.*amazonaws.com\//.test(image);
}
