declare module 'twig' {
    interface TwigTemplate {
        render(context?: Record<string, unknown>): string;
    }

    interface TwigParameters {
        data?: string;
        path?: string;
        base?: string;
        rethrow?: boolean;
        [key: string]: unknown;
    }

    interface TwigStatic {
        twig(params: TwigParameters): TwigTemplate;
        cache(enabled: boolean): void;
        extendFilter(
            name: string,
            fn: (value: unknown, args: unknown[] | false) => unknown
        ): void;
    }

    const Twig: TwigStatic;
    export default Twig;
}
