'use strict';
// Is one of my posts really gone? Used by the delete jobs before deleting (a delete whose answer was lost, or one
// interrupted by a restart, is never sent again once the post is gone) and to confirm afterwards.
// A 404 alone doesn't prove it: the post is read as its owner (the account's own blog, exact id), and the same
// identity must still be able to read that blog, so a wrong blog, signed-out session or other access problem
// throws instead of counting as deleted.

async function postGone(tumblr, blog, id) {
  try { await tumblr.getPost(blog, id); return false; }
  catch (e) { if (e?.status !== 404) throw e; }
  await tumblr.postsPage(blog, { limit: 1 }); // throws when the blog itself can't be read this way
  return true;
}

module.exports = { postGone };
