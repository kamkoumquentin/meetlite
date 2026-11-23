/**
 * common.js — Utilitaires partagés entre index.html, wait.html et room.html
 * Utilise sessionStorage pour conserver l'identité par onglet (pratique pour
 * tester plusieurs participants dans le même navigateur).
 */

window.MeetCommon = (function () {
  const NAME_STORAGE_KEY = 'meetlite_user_name';

  /**
   * Extrait le roomId depuis l'URL (/wait/:roomId ou /room/:roomId).
   */
  function getRoomIdFromPath() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  }

  /**
   * Indique si l'utilisateur courant a ouvert la page en tant qu'hôte (?host=1).
   */
  function isHostFromQuery() {
    const params = new URLSearchParams(window.location.search);
    return params.get('host') === '1';
  }

  function getUserName() {
    const params = new URLSearchParams(window.location.search);
    const urlName = params.get('name');
    if (urlName && urlName.trim()) {
      sessionStorage.setItem(NAME_STORAGE_KEY, urlName.trim());
      return urlName.trim();
    }
    return sessionStorage.getItem(NAME_STORAGE_KEY) || '';
  }

  function setUserName(name) {
    if (name && name.trim()) {
      sessionStorage.setItem(NAME_STORAGE_KEY, name.trim());
    }
  }

  function getHostToken(roomId) {
    if (!roomId) return '';
    return sessionStorage.getItem(`meetlite_host_token_${roomId}`) || '';
  }

  function setHostToken(roomId, token) {
    if (roomId && token) {
      sessionStorage.setItem(`meetlite_host_token_${roomId}`, token);
    }
  }

  /**
   * Demande le prénom si absent du sessionStorage de l'onglet courant.
   */
  function ensureUserName(defaultName = 'Participant') {
    let name = getUserName();
    if (!name) {
      name = prompt('Votre nom affiché dans la réunion :') || defaultName;
      setUserName(name);
    }
    return name;
  }

  /**
   * Copie un texte dans le presse-papiers.
   */
  async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const temp = document.createElement('textarea');
      temp.value = text;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      temp.remove();
    }
  }

  /**
   * Affiche une notification toast temporaire.
   */
  function showToast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 2600);
  }

  return {
    getRoomIdFromPath,
    isHostFromQuery,
    getUserName,
    setUserName,
    getHostToken,
    setHostToken,
    ensureUserName,
    copyToClipboard,
    showToast
  };
})();
