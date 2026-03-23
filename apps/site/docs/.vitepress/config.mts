import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'RaiFlow',
  description: 'A Nano payment runtime',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/what-is-raiflow' },
      { text: 'Roadmap', link: '/roadmap' },
      { text: 'RFCs', link: '/rfcs/' },
      { text: 'GitHub', link: 'https://github.com/openrai/raiflow' }
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'What is RaiFlow?', link: '/guide/what-is-raiflow' },
            { text: 'Doctrine', link: '/guide/doctrine' },
            { text: 'Monorepo layout', link: '/guide/monorepo' }
          ]
        }
      ],
      '/rfcs/': [
        {
          text: 'RFCs',
          items: [
            { text: 'RFC index', link: '/rfcs/' }
          ]
        }
      ]
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/openrai/raiflow' }
    ],
    footer: {
      message: 'Built in public by OpenRai.',
      copyright: `Copyright © ${new Date().getFullYear()} OpenRai contributors`
    }
  }
})
