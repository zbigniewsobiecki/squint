class Author < ApplicationRecord
  has_many :books, dependent: :destroy

  validates :name, presence: true, uniqueness: true
  validates :bio, length: { maximum: 2000 }

  scope :with_published_books, -> { joins(:books).where(books: { published: true }).distinct }

  def book_count
    books.count
  end

  def full_display_name
    bio.present? ? "#{name} — #{bio.truncate(80)}" : name
  end

  private

  def normalize_name
    self.name = name.strip.titleize if name.present?
  end
end
