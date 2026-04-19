// ============================================================================
// OpenClaw Custom Skill: TALINDA Task Manager
// Este archivo se registra como skill en OpenClaw para interceptar mensajes
// y reenviarlos al backend.
//
// Ubicar en: ~/.openclaw/skills/talinda-tasks/index.js
// ============================================================================

const BACKEND_URL = process.env.TALINDA_BACKEND_URL || 'http://localhost:3000';

module.exports = {
  name: 'talinda-tasks',
  description: 'Gestión de tareas para empleados de TALINDA',

  // Match all incoming messages on WhatsApp
  match: (message) => {
    return message.channel === 'whatsapp';
  },

  // Process the message
  handler: async (message, context) => {
    try {
      const payload = {
        type: message.type || 'message',
        from: message.from,
        text: message.text || message.body || '',
        userId: message.userId,
        isVoice: message.type === 'voice',
        media: message.media || null,
        mediaUrl: message.mediaUrl || null,
        caption: message.caption || '',
        fileName: message.fileName || null,
        mimeType: message.mimeType || null,
        fileSize: message.fileSize || 0,
        timestamp: message.timestamp || Date.now(),
        raw: message,
      };

      const response = await fetch(`${BACKEND_URL}/webhook/openclaw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(`[TALINDA] Backend error: ${response.status}`);
        return { text: 'Hubo un error procesando tu mensaje. Intenta de nuevo.' };
      }

      const data = await response.json();

      if (data.reply) {
        return { text: data.reply };
      }

      return null; // No reply needed
    } catch (err) {
      console.error(`[TALINDA] Skill error: ${err.message}`);
      return { text: 'El sistema no está disponible. Intenta más tarde.' };
    }
  },
};
