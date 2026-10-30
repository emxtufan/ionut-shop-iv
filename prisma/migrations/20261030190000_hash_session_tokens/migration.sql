-- Session tokens are stored as their sha256 hex digest from now on: a leaked Session
-- row can no longer be replayed as a cookie. Existing rows hold raw tokens, so they are
-- hashed in place and the sessions already signed in stay valid.
UPDATE "Session" SET "token" = encode(sha256("token"::bytea), 'hex');
