import { defineConfig } from 'vitepress'
import markdownItTaskLists from 'markdown-it-task-lists'

export default defineConfig({
  markdown: {
    config: (md) => {
      md.use(markdownItTaskLists)
    }
  },
  title: 'RaiFlow',
  description: 'An open-source Nano payment runtime initiative',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Runtime', link: '/runtime/' },
      { text: 'Roadmap', link: '/roadmap' },
      { text: 'RFCs', link: '/rfcs/' },
      { text: 'GitHub', link: 'https://github.com/openrai/raiflow' }
    ],
    sidebar: {
      '/runtime/': [
        {
          text: 'Runtime',
          items: [
            { text: 'Overview', link: '/runtime/' },
            { text: 'Event model', link: '/runtime/model' },
            { text: 'Code examples', link: '/runtime/examples' }
          ]
        }
      ],
      '/rfcs/': [
        {
          text: 'RFCs',
          items: [
            { text: 'RFC index', link: '/rfcs/' },
            { text: '0001 — Project framing', link: '/rfcs/0001-project-framing' },
            { text: '0002 — Observe mode', link: '/rfcs/0002-observe-mode' },
            { text: '0003 — Event model', link: '/rfcs/0003-event-model' }
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
