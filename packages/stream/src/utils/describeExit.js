/**
 * Describes how a process ended: the wait status as a phrase, plus a short
 * stderr tail (last three lines) for attribution messages and logs.
 */
export function describeExit(exit) {
  const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
  const tail = exit.errors.split('\n').slice(-3).join(' | ');
  return { how, tail };
}
