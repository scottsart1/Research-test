/**
 * resume-utils.js — byte <-> base64 conversion shared by the background
 * service worker (seeds the bundled resume on install) and filler.js
 * (reconstructs a File for DataTransfer injection). No dependencies; uses
 * the standard btoa/atob globals available in both service workers and
 * content scripts (and in Node 16+, so this is unit-testable directly).
 */
(function (root) {
  'use strict';

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000; // avoid call-stack blowups on large files
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  const ResumeUtils = { bytesToBase64, base64ToBytes };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ResumeUtils;
  }
  root.ResumeUtils = ResumeUtils;
})(typeof self !== 'undefined' ? self : this);
