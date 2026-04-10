class BookSerializer
  attr_reader :book

  def initialize(book)
    @book = book
  end

  def as_json
    {
      id: book.id,
      title: book.title,
      isbn: book.isbn,
      price: book.price,
      in_stock: book.in_stock?,
      stock_count: book.stock_count,
      author: author_summary,
      published: book.published
    }
  end

  private

  def author_summary
    return nil unless book.author

    { id: book.author.id, name: book.author.name }
  end
end
