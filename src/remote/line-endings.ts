/**
 * Git on Windows checks text files out with CRLF line endings, and the uploader sends the working tree as it is.
 * A shell script with CRLF fails on the Mac ("set: -\r: invalid option"). Run this in the uploaded source folder
 * before any repository preparation command or build: it converts the files a Mac would execute to LF.
 * Binary and Xcode project files are not touched, and the upload folder is disposable, so this never changes the user's repository.
 */
export const NORMALIZE_SCRIPT_LINE_ENDINGS = `find . -type f \\( -name '*.sh' -o -name '*.bash' -o -name '*.command' -o -name Podfile -o -name Gemfile \\) -not -path './.git/*' -exec perl -pi -e 's/\\r$//' {} + 2>/dev/null || true`;
