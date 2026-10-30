import { ThemeConfig } from 'antd';

// IV Concept brand (ivconcept.ro): sand background, cream surfaces, dark brown ink, gold accents
const sand = '#e8e0d6';
const cream = '#f8f3ec';
const ink = '#2c2218';
const inkSoft = '#433223';
const muted = '#8b6847';
const gold = '#b38b60';
const border = 'rgba(44, 34, 24, 0.12)';

export const brandTheme: ThemeConfig = {
  token: {
    colorPrimary: ink,
    colorInfo: gold,
    colorSuccess: '#3f6b35',
    colorWarning: '#b7791f',
    colorError: '#b23b3b',
    colorLink: ink,
    colorBgBase: cream,
    colorBgContainer: cream,
    colorBgElevated: cream,
    colorBgLayout: sand,
    colorBorder: border,
    colorBorderSecondary: 'rgba(44, 34, 24, 0.07)',
    colorText: ink,
    colorTextSecondary: muted,
    colorTextTertiary: 'rgba(139, 104, 71, 0.75)',
    colorTextPlaceholder: 'rgba(139, 104, 71, 0.7)',
    borderRadius: 12,
    fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
  },
  components: {
    Button: {
      borderRadius: 10,
      controlHeight: 40,
      fontWeight: 500,
      defaultBg: 'transparent',
      defaultColor: ink,
      defaultBorderColor: 'rgba(44, 34, 24, 0.2)',
      defaultHoverBg: 'rgba(44, 34, 24, 0.05)',
      defaultHoverColor: ink,
      defaultHoverBorderColor: 'rgba(44, 34, 24, 0.35)',
      primaryColor: cream,
      primaryShadow: 'none',
      colorPrimaryHover: inkSoft,
    },
    Input: {
      colorBgContainer: '#fffaf4',
      colorBorder: border,
      borderRadius: 10,
      activeBorderColor: gold,
      hoverBorderColor: 'rgba(44, 34, 24, 0.3)',
    },
    Modal: {
      contentBg: cream,
      headerBg: cream,
      borderRadiusLG: 16,
    },
    Drawer: {
      colorBgElevated: cream,
    },
    Table: {
      colorBgContainer: cream,
      headerBg: '#f1e9de',
      headerColor: muted,
      rowHoverBg: 'rgba(44, 34, 24, 0.03)',
      borderColor: 'rgba(44, 34, 24, 0.08)',
      borderRadius: 12,
    },
    Tabs: {
      itemColor: muted,
      itemSelectedColor: ink,
      itemHoverColor: inkSoft,
      inkBarColor: gold,
      titleFontSize: 14,
    },
    Dropdown: {
      colorBgElevated: cream,
      borderRadiusLG: 12,
    },
    Select: {
      colorBgContainer: '#fffaf4',
      colorBorder: border,
      borderRadius: 10,
    },
    Switch: {
      colorPrimary: gold,
      colorPrimaryHover: muted,
    },
    Tag: {
      borderRadiusSM: 6,
    },
  },
};
