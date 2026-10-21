import type { Messages } from './messages';

export const es = {
  languageName: 'Español',
  skipToContent: 'Saltar al contenido',
  header: {
    navigation: 'Principal',
    signIn: 'Iniciar sesión',
  },
  home: {
    title: 'Tu producto empieza aquí',
    description:
      'El punto de partida de un producto web: cuentas, roles, correo y una API tipada, en producción desde el primer commit.',
    heading: ['Tu producto', 'empieza aquí.'],
    lead: 'El punto de partida de un producto web: cuentas, roles, correo y una API tipada, en producción desde el primer commit.',
    action: 'Abrir la aplicación',
  },
  capabilities: {
    heading: 'Qué incluye',
    items: [
      {
        name: 'Cuentas y roles',
        description:
          'Inicio de sesión, recuperación por correo, invitaciones y roles de administración, con sesiones que rotan y detectan robos.',
      },
      {
        name: 'Una API tipada',
        description:
          'Un solo contrato OpenAPI genera el cliente de la aplicación: la aplicación y la API nunca se desalinean.',
      },
      {
        name: 'Seguro por defecto',
        description:
          'Protección CSRF, cabeceras de seguridad estrictas, límites de peticiones y dependencias revisadas antes de instalarse.',
      },
      {
        name: 'Listo para operar',
        description:
          'Sondas de salud, logs estructurados, métricas y despliegues con una vuelta atrás probada.',
      },
      {
        name: 'Páginas rápidas',
        description:
          'Este sitio es HTML y CSS generados de antemano: nada que esperar, nada que se rompa.',
      },
      {
        name: 'Dos idiomas',
        description:
          'Cada página existe en inglés y en español, enlazadas para que los buscadores muestren la correcta.',
      },
    ],
  },
  gettingIn: {
    heading: 'Cómo se entra',
    invited: 'Primero, un administrador te invita.',
    accepted: 'Después eliges tu nombre y una contraseña.',
    signedIn: 'Y ya estás dentro.',
    pictures: {
      inviteForm:
        'El formulario de invitación de la aplicación, completado: la dirección ada@example.com, invitada como miembro.',
      invitationEmail:
        'El correo de invitación: un administrador invitó a esta dirección a crear una cuenta, con un enlace que funciona una vez, durante 7 días.',
      acceptForm:
        'La página que acepta la invitación, completada: el nombre Ada Lovelace y una contraseña de al menos 15 caracteres.',
      home: 'La aplicación con la sesión iniciada: la bienvenida a Ada Lovelace, con su correo y su rol.',
    },
  },
  callToAction: {
    heading: ['Ahora', 'es tuyo.'],
    body: 'Inicia sesión con tu cuenta o pide una invitación a un administrador.',
    action: 'Iniciar sesión',
  },
  footer: {
    openApp: 'Abrir la aplicación',
    languages: 'Idiomas',
    rights: 'Todos los derechos reservados.',
    backToTop: 'Volver arriba',
  },
  notFound: {
    title: 'Página no encontrada',
    heading: ['Aquí no', 'hay nada.'],
    body: 'Puede que la dirección esté mal escrita o que la página se haya movido.',
    action: 'Ir a la página de inicio',
  },
} as const satisfies Messages;
