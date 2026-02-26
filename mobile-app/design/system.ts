export const DS = {
  colors: {
    canvas: '#F4F7F4',
    surface: '#FFFFFF',
    surfaceMuted: '#ECF3F1',
    brand: '#0F766E',
    brandStrong: '#115E59',
    accent: '#C7791A',
    textPrimary: '#123034',
    textSecondary: '#4A6568',
    textMuted: '#6F8386',
    border: '#D7E2DF',
    success: '#1F8B4C',
    warning: '#B45309',
    danger: '#B42318',
    info: '#1660CF',
  },
  spacing: {
    xxs: 4,
    xs: 8,
    sm: 12,
    md: 16,
    lg: 24,
    xl: 32,
  },
  radius: {
    sm: 10,
    md: 14,
    lg: 20,
    pill: 999,
  },
  typography: {
    hero: 32,
    title: 24,
    subtitle: 18,
    body: 16,
    caption: 13,
    micro: 11,
  },
  shadow: {
    card: {
      shadowColor: '#052A27',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.08,
      shadowRadius: 14,
      elevation: 3,
    },
  },
};

export const baseStyles = {
  screen: {
    flex: 1,
    backgroundColor: DS.colors.canvas,
  },
  content: {
    paddingHorizontal: DS.spacing.md,
    paddingVertical: DS.spacing.md,
  },
  card: {
    backgroundColor: DS.colors.surface,
    borderRadius: DS.radius.md,
    borderWidth: 1,
    borderColor: DS.colors.border,
    ...DS.shadow.card,
  },
};
