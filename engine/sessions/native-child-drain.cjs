"use strict";

/** A lost stdio-close event must not keep an already exited brain in custody. */
function nativeChildExited(child) {
  if (Number.isInteger(child.exitCode) || typeof child.signalCode === "string" && child.signalCode.length > 0) return true;
  if (!Number.isInteger(child.pid) || child.pid <= 1) return false;
  try { process.kill(child.pid, 0); }
  catch (error) { return error?.code === "ESRCH"; }
  return false;
}

function waitForNativeChildren(children) {
  return Promise.all([...children].map(child => new Promise(resolve => {
    let finished = false;
    let poll;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      child.removeListener("close", finish);
      child.removeListener("exit", observeExit);
      children.delete(child);
      resolve();
    };
    const observeExit = () => { if (nativeChildExited(child)) finish(); };
    // Observe first, then inspect: termination between those steps cannot be
    // missed. A signal request or elapsed timeout alone never proves exit.
    child.once("close", finish);
    child.once("exit", observeExit);
    observeExit();
    if (!finished) {
      poll = setInterval(observeExit, 250);
      poll.unref?.();
    }
  })));
}

module.exports = { nativeChildExited, waitForNativeChildren };
