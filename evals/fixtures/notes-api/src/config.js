export const config = {
  port: Number(process.env.PORT ?? 8080),
  /** The longest text a note may have, in characters. */
  maxNoteLength: 500,
  /** How long a login lasts. */
  sessionMinutes: 45,
};
