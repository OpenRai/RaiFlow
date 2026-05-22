// Auto-mock for nano-rspow-node to avoid loading native binary in tests.
export const WorkType = { Send: 'send', Receive: 'receive' };
export const generateWork = async (_hash: string, _workType: string): Promise<string> => 'mockedwork0000000';
export const validateWork = (_hash: string, _work: string, _workType: string): boolean => true;
