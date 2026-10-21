import type { Messages } from './messages';

export const en = {
  languageName: 'English',
  skipToContent: 'Skip to content',
  header: {
    navigation: 'Main',
    signIn: 'Sign in',
  },
  home: {
    title: 'Your product starts here',
    description:
      'The starting point for a web product: accounts, roles, email and a typed API, in production from the first commit.',
    heading: ['Your product', 'starts here.'],
    lead: 'The starting point for a web product: accounts, roles, email and a typed API, in production from the first commit.',
    action: 'Open the app',
  },
  capabilities: {
    heading: 'What is included',
    items: [
      {
        name: 'Accounts and roles',
        description:
          'Sign-in, recovery by email, invitations and administrator roles, with sessions that rotate and detect theft.',
      },
      {
        name: 'A typed API',
        description:
          "One OpenAPI contract generates the app's client, so the app and the API never drift apart.",
      },
      {
        name: 'Secure by default',
        description:
          'CSRF protection, strict security headers, rate limits and dependencies checked before they install.',
      },
      {
        name: 'Ready to operate',
        description:
          'Health probes, structured logs, metrics and deployments with a tested way back.',
      },
      {
        name: 'Fast pages',
        description:
          'This site is plain HTML and CSS built ahead of time: nothing to wait for, nothing to break.',
      },
      {
        name: 'Two languages',
        description:
          'Every page exists in English and Spanish, linked so that search engines show the right one.',
      },
    ],
  },
  gettingIn: {
    heading: 'Getting in',
    invited: 'First, an administrator invites you.',
    accepted: 'Then you choose your name and a password.',
    signedIn: 'And you are in.',
    pictures: {
      inviteForm:
        'The invitation form of the app, filled in: the address ada@example.com, invited as a member.',
      invitationEmail:
        'The invitation email: an administrator invited this address to create an account, with a link that works once, for 7 days.',
      acceptForm:
        'The page that accepts the invitation, filled in: the name Ada Lovelace and a password of at least 15 characters.',
      home: 'The app once signed in: a welcome for Ada Lovelace, with her email address and her role.',
    },
  },
  callToAction: {
    heading: ['Now it is', 'yours.'],
    body: 'Sign in with your account, or ask an administrator for an invitation.',
    action: 'Sign in',
  },
  footer: {
    openApp: 'Open the app',
    languages: 'Languages',
    rights: 'All rights reserved.',
    backToTop: 'Back to top',
  },
  notFound: {
    title: 'Page not found',
    heading: ['Nothing', 'lives here.'],
    body: 'The address may be mistyped, or the page may have moved.',
    action: 'Go to the home page',
  },
} as const satisfies Messages;
