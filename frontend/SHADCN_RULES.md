# Shadcn UI Component Rules

This project uses [shadcn/ui](https://ui.shadcn.com/) components for the frontend UI.

## Rules for Using Components

### 1. Always Use Shadcn Components

**DO:**

- Use components from `@/components/ui/` directory
- Install new components using `npx shadcn@latest add [component-name]`
- Import components from `@/components/ui/[component-name]`

**DON'T:**

- Create custom implementations of components that exist in shadcn
- Copy/paste component code from other sources
- Modify shadcn component files directly (unless customizing for project needs)

### 2. Component Installation

When you need a new component:

```bash
cd frontend
npx shadcn@latest add [component-name]
```

This will:

- Install the component to `src/components/ui/`
- Add any required dependencies to `package.json`
- Follow the configuration in `components.json`

### 3. Available Components

Current shadcn components in use:

- `button` - Button component
- `input` - Input field component
- `switch` - Toggle switch component
- `label` - Form label component
- `popover` - Popover/dropdown component
- `select` - Select dropdown component
- `card` - Card container component
- `dropdown-menu` - Dropdown menu component
- `table` - Table component
- `calendar` - Calendar/date picker component

### 4. Import Pattern

Always import from the ui directory:

```typescript
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
```

### 5. Styling

- Components use Tailwind CSS classes
- Use `twMerge(clsx(...))` for conditional classes (import from `clsx` and `tailwind-merge`)
- Follow the design system defined in `components.json` (style: "new-york")
- Use CSS variables for theming (defined in `src/index.css`)

### 6. Configuration

Component configuration is in `frontend/components.json`:

- Style: "new-york"
- TypeScript: enabled
- Tailwind: configured
- Aliases: `@/components`, `@/lib`, `@/hooks`

### 7. Customization

If you need to customize a component:

1. The component file is in `src/components/ui/` - you can modify it
2. Keep the component API consistent with shadcn patterns
3. Document any significant customizations

### 8. Adding New Components

Before creating a custom component, check if shadcn has it:

- Visit https://ui.shadcn.com/docs/components
- If available, install it using `npx shadcn@latest add`
- If not available, create a custom component following shadcn patterns

## Examples

### Using Input Component

```typescript
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

<Label htmlFor="email">Email</Label>
<Input id="email" type="email" placeholder="Enter email" />
```

### Using Switch Component

```typescript
import { Switch } from "@/components/ui/switch"

<Switch checked={enabled} onCheckedChange={setEnabled} />
```

### Using Button Component

```typescript
import { Button } from "@/components/ui/button"

<Button variant="outline" onClick={handleClick}>
  Click me
</Button>
```

## Resources

- [Shadcn UI Documentation](https://ui.shadcn.com/)
- [Component Examples](https://ui.shadcn.com/docs/components)
- [Configuration Guide](https://ui.shadcn.com/docs/installation)
