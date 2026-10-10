import { renderControl as render, type Control, type Tab as SharedTab } from '../controls';
import { CHOICES, RANGES, type DevConfig } from './config';
import type { Dev } from './Dev';

export { keyName, type Binding, type Control, type Section, type Rendered } from '../controls';
export interface Tab extends Omit<SharedTab, 'configKey'> { configKey?: keyof DevConfig }
export const renderControl = (dev: Dev, control: Control) => render(dev, control, RANGES, CHOICES);
