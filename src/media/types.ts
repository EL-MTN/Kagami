export interface PhotoQuery {
  mood?: string;
  category?: string;
  context?: string;
}

export interface SelectedPhoto {
  id: string;
  filePath: string;
  telegramFileId?: string;
  tags: string[];
}
