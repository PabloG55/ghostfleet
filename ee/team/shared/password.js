// shared/password.js — the shortest password the server accepts for a NEW one (POST /api/password
// refuses anything under it). The two forms that set one and the words that name the limit all
// read this, so the button, the placeholder and the server cannot drift apart again: they did
// once, the page saying 6 while the server wanted 12, and the form looked valid and then failed.
export const PASSWORD_MIN = 12;
