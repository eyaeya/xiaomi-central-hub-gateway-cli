import { NotConfirmedError, XggError } from './errors.js';

/**
 * Reclassify a failure that happened after a gateway write acknowledgement.
 * The original error remains available as structured diagnostic context, but
 * callers receive the only safe retry contract: inspect live state first.
 */
export function notConfirmedAfterAcknowledgement(
  error: unknown,
  message: string,
  details: Record<string, unknown>,
): NotConfirmedError {
  if (error instanceof NotConfirmedError) return error;

  const causeDetails: Record<string, unknown> = {};
  if (error instanceof XggError) {
    causeDetails.causeCode = error.code;
    causeDetails.causeMessage = error.message;
    if (error.details !== undefined) causeDetails.causeDetails = error.details;
  } else if (error instanceof Error) {
    causeDetails.causeName = error.name;
    causeDetails.causeMessage = error.message;
  } else {
    causeDetails.causeType = typeof error;
  }

  return new NotConfirmedError(message, { ...details, ...causeDetails });
}
